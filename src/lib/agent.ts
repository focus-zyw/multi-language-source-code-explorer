import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { AiError } from "./ai-error.ts";

export interface AgentConfig {
  command: string;
  prefix: string[];
  model: string | null;
  timeoutMs: number;
}

function executable(path: string): Pick<AgentConfig, "command" | "prefix"> | null {
  if (!existsSync(/* turbopackIgnore: true */ path)) return null;
  if (/\.(?:c?js|mjs)$/i.test(path)) return { command: process.execPath, prefix: [path] };
  if (/\.(?:cmd|bat|ps1)$/i.test(path)) {
    const npmEntry = join(/* turbopackIgnore: true */ dirname(path), "node_modules", "@openai", "codex", "bin", "codex.js");
    return existsSync(/* turbopackIgnore: true */ npmEntry) ? { command: process.execPath, prefix: [npmEntry] } : null;
  }
  return { command: path, prefix: [] };
}

export function getAgentConfig(): AgentConfig | null {
  if (process.env.AI_AGENT_ENABLED === "false") return null;
  const candidates: string[] = [];
  const custom = process.env.AI_AGENT_COMMAND;
  if (custom && isAbsolute(custom)) candidates.push(custom);
  if (!custom) {
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const name of process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"]) {
        candidates.push(join(/* turbopackIgnore: true */ dir, name));
      }
    }
    // The desktop app updates this directory on each release; do not hardcode its hash.
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      const bin = join(/* turbopackIgnore: true */ process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      try {
        candidates.push(...readdirSync(/* turbopackIgnore: true */ bin).map((dir) => join(/* turbopackIgnore: true */ bin, dir, "codex.exe"))
          .filter((path) => existsSync(/* turbopackIgnore: true */ path))
          .sort((a, b) => statSync(/* turbopackIgnore: true */ b).mtimeMs - statSync(/* turbopackIgnore: true */ a).mtimeMs));
      } catch { /* The desktop app is optional. */ }
    }
  }
  for (const path of candidates) {
    const resolved = executable(path);
    if (!resolved) continue;
    const timeout = Number(process.env.AI_AGENT_TIMEOUT_MS ?? 300_000);
    return { ...resolved, model: process.env.AI_AGENT_MODEL?.trim() || null,
      timeoutMs: Number.isFinite(timeout) ? Math.min(600_000, Math.max(1000, timeout)) : 300_000 };
  }
  return null;
}

export function agentArguments(cfg: AgentConfig): string[] {
  return [...cfg.prefix, "exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral",
    "--sandbox", "read-only", "--color", "never", "-c", "approval_policy=\"never\"",
    "-c", "features.shell_tool=false", "-c", "project_doc_max_bytes=0", "-c", "model_reasoning_effort=\"low\"",
    ...(cfg.model ? ["--model", cfg.model] : []), "-"];
}

/** Prompt travels through stdin, never through a shell or command-line arguments. */
export async function completeAgent(cfg: AgentConfig, system: string, user: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new AiError("讲解已取消", 499);
  const cwd = await mkdtemp(join(tmpdir(), "code-atlas-agent-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      // Whitelist environment variables; application model keys and DB settings stay out.
      const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
      for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      const child = spawn(cfg.command, agentArguments(cfg), { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let bytes = 0;
      let failure: AiError | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: AiError) => {
        if (failure) return;
        failure = error;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
          killer.on("error", () => child.kill());
        } else if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        killTimer.unref();
      };
      const timer = setTimeout(() => stop(new AiError("Agent 运行超时，请稍后重试或增加 AI_AGENT_TIMEOUT_MS", 504)), cfg.timeoutMs);
      const onAbort = () => stop(new AiError("讲解已取消", 499));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 128_000) stop(new AiError("Agent 返回内容超过上限，请缩小讲解范围"));
        else output += chunk;
      });
      // Drain progress logs without returning or persisting potentially sensitive diagnostics.
      child.stderr.resume();
      child.stdin.on("error", () => { /* Early process exits are handled below. */ });
      child.stdin.end(`${system}\n\n你只需根据下方提供的信息直接输出讲解，不要使用工具、读取其他文件或执行代码。讲解控制在 600 字以内。\n\n${user}`);
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      child.once("error", () => { cleanup(); reject(new AiError("无法启动 Codex，请检查 AI_AGENT_COMMAND 或本机安装", 503)); });
      child.once("close", (code) => {
        cleanup();
        if (failure) reject(failure);
        else if (code !== 0) reject(new AiError("Codex 运行失败，请在终端执行 codex login，并确认 CLI 已更新且可联网", 502));
        else if (!output.trim()) reject(new AiError("Agent 返回了空内容"));
        else resolve(output.trim());
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
