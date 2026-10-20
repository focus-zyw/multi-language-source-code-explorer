import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { AiError } from "./ai-error.ts";
import type { AgentPhase } from "./ai-types.ts";

export interface AgentConfig {
  command: string;
  prefix: string[];
  model: string | null;
  timeoutMs: number;
}

/** Bounds apply to both the JSONL stream and the file exec writes the final message to. */
const MAX_OUTPUT_BYTES = 128_000;
const LAST_MESSAGE_FILE = "last-message.txt";

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

/**
 * `--output-last-message` makes exec write the final answer itself, including its own fallback to
 * turn items. Item notifications are dropped under backpressure, and `--ephemeral` disables the
 * `turn.completed` backfill, so the event stream alone can end without the final message.
 */
export function agentArguments(cfg: AgentConfig, lastMessagePath?: string): string[] {
  return [...cfg.prefix, "exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral",
    "--sandbox", "read-only", "--color", "never",
    ...(lastMessagePath ? ["--output-last-message", lastMessagePath] : []),
    "-c", "approval_policy=\"never\"", "-c", "features.shell_tool=false", "-c", "project_doc_max_bytes=0", "-c", "model_reasoning_effort=\"low\"",
    ...(cfg.model ? ["--model", cfg.model] : []), "-"];
}

/** Missing or unusable files are not failures: older CLIs and wrappers simply never write one. */
async function readLastMessage(path: string): Promise<{ text: string; tooLarge: boolean }> {
  try {
    const info = await stat(/* turbopackIgnore: true */ path);
    if (!info.isFile()) return { text: "", tooLarge: false };
    if (info.size > MAX_OUTPUT_BYTES) return { text: "", tooLarge: true };
    return { text: (await readFile(/* turbopackIgnore: true */ path, "utf8")).trim(), tooLarge: false };
  } catch {
    return { text: "", tooLarge: false };
  }
}

/** Prompt travels through stdin, never through a shell or command-line arguments. */
export async function completeAgent(cfg: AgentConfig, system: string, user: string, signal?: AbortSignal, onProgress?: (phase: AgentPhase) => void): Promise<string> {
  if (signal?.aborted) throw new AiError("讲解已取消", 499);
  let lastPhase: AgentPhase | undefined;
  const progress = (phase: AgentPhase) => { if (phase !== lastPhase) { lastPhase = phase; onProgress?.(phase); } };
  progress("starting");
  const cwd = await mkdtemp(join(tmpdir(), "code-atlas-agent-"));
  const lastMessagePath = join(cwd, LAST_MESSAGE_FILE);
  try {
    return await new Promise<string>((resolve, reject) => {
      // Whitelist environment variables; application model keys and DB settings stay out.
      const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
      for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      const child = spawn(cfg.command, agentArguments(cfg, lastMessagePath), { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let pending = "";
      let completed = false;
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
      const eventLine = (line: string) => {
        if (!line.trim() || failure) return;
        let event: { type?: string; item?: { type?: string; phase?: string; text?: string } };
        try { event = JSON.parse(line); }
        catch { stop(new AiError("Agent 返回的事件格式无效，请确认 Codex CLI 支持 --json", 502)); return; }
        if (!event || typeof event !== "object") { stop(new AiError("Agent 返回的事件格式无效", 502)); return; }
        if (event.type === "turn.started") progress("running");
        // exec currently omits `phase`, but wrappers may emit commentary items; only final text is kept.
        else if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.phase !== "commentary" && typeof event.item.text === "string") {
          output = event.item.text;
          progress("responding");
        } else if (event.type === "turn.completed") { completed = true; progress("finishing"); }
        else if (event.type === "turn.failed") stop(new AiError("Agent 模型请求失败，请检查登录、网络和模型配置", 502));
        // An unrecoverable stream error; the process may still exit 0 with partial or no text.
        else if (event.type === "error") stop(new AiError("Agent 运行出错，请稍后重试", 502));
        // Reasoning, tool payloads and raw errors never reach the UI or application logs.
      };
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) stop(new AiError("Agent 返回内容超过上限，请缩小讲解范围"));
        else {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) { eventLine(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
        }
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
      const finish = async (code: number | null) => {
        if (!failure && pending.trim()) eventLine(pending);
        cleanup();
        if (failure) { reject(failure); return; }
        // The file is authoritative; the event stream is the fallback for CLIs without the flag.
        const written = await readLastMessage(lastMessagePath);
        if (written.tooLarge) { reject(new AiError("Agent 返回内容超过上限，请缩小讲解范围")); return; }
        const text = written.text || output.trim();
        if (code !== 0) reject(new AiError("Codex 运行失败，请在终端执行 codex login，并确认 CLI 已更新且可联网", 502));
        else if (!text) reject(new AiError("Agent 返回了空内容"));
        else if (!completed) reject(new AiError("Agent 分析未完成，请重试", 502));
        else resolve(text);
      };
      child.once("close", (code) => {
        void finish(code).catch(() => reject(new AiError("Agent 运行失败，请稍后重试", 502)));
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
