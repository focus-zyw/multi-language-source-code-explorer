import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImportError } from "./ingest/rules.ts";
import type { CoverageFile, TestRunnerProfile, TestRunResult, RunnerKind } from "./test-run-types.ts";

interface Profile extends TestRunnerProfile { kind: RunnerKind; executable: string; args: string[] }
interface Slot { root: string; result: TestRunResult; controller: AbortController }
const shared = globalThis as typeof globalThis & { __atlasTestRuns?: Map<number, Slot> };
const runs = shared.__atlasTestRuns ??= new Map<number, Slot>();
export const hashSource = (source: string) => createHash("sha256").update(source).digest("hex");

export async function projectRoot(source: string): Promise<string> {
  if (!path.isAbsolute(source) || /^(?:\\\\|\/\/)/.test(source)) throw new ImportError("测试只支持本机项目目录", 409);
  try {
    if ((await lstat(source)).isSymbolicLink()) throw new Error();
    const root = await realpath(source);
    if (root === path.parse(root).root || !(await lstat(root)).isDirectory()) throw new Error();
    return root;
  } catch { throw new ImportError("项目目录不可用或为链接，请重新导入真实目录", 409); }
}

/** Never follow a link/junction while reading a project or report file. */
export async function safeFile(root: string, relative: string, maxBytes = 1_100_000): Promise<string> {
  const normalized = relative.replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("invalid path");
  let current = root;
  for (const part of normalized.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("linked path");
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size > maxBytes) throw new Error("invalid file");
  const actual = await realpath(current);
  const rel = path.relative(root, actual);
  if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) throw new Error("outside root");
  return readFile(current, "utf8");
}

// Only simple argv scripts are supported; shell chains and environment assignments are not interpreted.
export function scriptArguments(script: string): string[] | null {
  if (/[;&|<>`$\r\n]/.test(script)) return null;
  const tokens = script.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g);
  if (!tokens || tokens.join(" ").replace(/\s/g, "") !== script.trim().replace(/\s/g, "")) return null;
  return tokens.map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
}

export async function discoverRunners(root: string): Promise<Profile[]> {
  const found: Profile[] = [];
  try {
    const pkg = JSON.parse(await safeFile(root, "package.json"));
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? Object.entries(pkg.scripts) : [];
    for (const [name, script] of scripts.slice(0, 100)) {
      if (!/^test(?::[\w-]+)?$/.test(name) || typeof script !== "string") continue;
      const argv = scriptArguments(script);
      if (!argv) continue;
      const [tool, ...args] = argv;
      if (args.some((a) => /^(?:--watch|--inspect|--test-only|--coverage|--reporter|--outputFile|--ui)/.test(a) || a === "watch" || a === "dev")) continue;
      let kind: RunnerKind, executable: string, prefix: string[];
      if (tool === "node" && args.includes("--test")) { kind = "node"; executable = process.execPath; prefix = []; }
      else if (tool === "vitest" || tool === "jest") {
        kind = tool;
        const entry = tool === "vitest" ? "node_modules/vitest/vitest.mjs" : "node_modules/jest/bin/jest.js";
        // Runner packages may be package-manager links. They are executed only after explicit opt-in.
        try { if (!(await lstat(path.join(root, entry))).isFile()) continue; } catch { continue; }
        executable = process.execPath; prefix = [path.join(root, entry)];
      } else continue;
      found.push({ id: name, label: `${name} · ${kind}`, command: script, coverage: kind !== "node", kind, executable, args: [...prefix, ...args] });
    }
  } catch { /* A package manifest is optional. */ }
  for (const marker of ["pytest.ini", "pyproject.toml", "setup.cfg"]) {
    try {
      const config = await safeFile(root, marker);
      if (marker !== "pytest.ini" && !config.includes("pytest")) continue;
      const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
      let executable = process.platform === "win32" ? "python.exe" : "python3";
      try { if ((await lstat(path.join(root, python))).isFile()) executable = path.join(root, python); } catch { /* Use PATH. */ }
      found.push({ id: "pytest", label: "pytest", command: "python -m pytest", coverage: true, kind: "pytest", executable, args: ["-m", "pytest"] });
      break;
    } catch { /* No pytest configuration. */ }
  }
  return found;
}

/** LCOV line counts are evidence for the whole run, never per-test attribution. */
export function parseLcov(text: string, root: string): { path: string; lines: { line: number; hits: number }[] }[] {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const row of text.split(/\r?\n/)) {
    if (row.startsWith("SF:")) {
      const source = row.slice(3).replace(/\\/g, "/");
      const relative = path.isAbsolute(source) ? path.relative(root, source).replace(/\\/g, "/") : source;
      current = undefined;
      if (!relative || /^[a-z]:/i.test(relative) || relative.split("/").some((p) => !p || p === "." || p === "..")) continue;
      current = files.get(relative) ?? new Map(); files.set(relative, current);
    } else if (row === "end_of_record") current = undefined;
    else if (current && /^DA:\d+,\d+(?:,.*)?$/.test(row)) {
      const [line, hits] = row.slice(3).split(",").map(Number);
      if (line > 0 && Number.isSafeInteger(line) && Number.isSafeInteger(hits) && current.size < 100_000) current.set(line, (current.get(line) ?? 0) + hits);
    }
    if (files.size > 5000) throw new Error("coverage file limit");
  }
  return [...files].map(([file, lines]) => ({ path: file, lines: [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits })) }));
}

export function latestRun(projectId: number): TestRunResult | null { return runs.get(projectId)?.result ?? null; }
export function stopProjectTests(projectId: number): void { runs.get(projectId)?.controller.abort(); }
export function cancelRun(projectId: number, runId: string): void {
  const slot = runs.get(projectId);
  if (!slot || slot.result.id !== runId) throw new ImportError("测试任务不存在或已被替换", 409);
  slot.controller.abort();
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CI: "1", NO_COLOR: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export async function startRun(projectId: number, root: string, profile: Profile, coverage: boolean, sources: { path: string; content: string }[], timeoutMs = 120_000): Promise<TestRunResult> {
  if ([...runs.values()].some((s) => s.result.status === "running" && (s.root === root || runs.get(projectId) === s))) throw new ImportError("该项目目录已有测试正在运行", 409);
  if ([...runs.values()].filter((s) => s.result.status === "running").length >= 2) throw new ImportError("最多同时运行两个项目的测试", 429);
  if (coverage && !profile.coverage) throw new ImportError("此 runner 暂不支持行覆盖率", 400);
  const controller = new AbortController();
  const result: TestRunResult = { id: randomUUID(), status: "running", command: profile.command, startedAt: Date.now(), exitCode: null, output: "", truncated: false, coverage: [], coverageNote: coverage ? "正在收集本次运行的覆盖率" : "本次未收集覆盖率" };
  // Reserve before asynchronous filesystem work to prevent double-starts.
  runs.set(projectId, { root, result, controller });
  for (const [id, slot] of runs) if (runs.size > 30 && slot.result.status !== "running" && id !== projectId) runs.delete(id);
  void execute().catch(() => { result.status = "error"; result.finishedAt = Date.now(); result.coverageNote = "测试运行失败"; });
  return result;

  async function execute() {
    let temp: string | undefined;
    let outcome: TestRunResult["status"] = "error";
    try {
      temp = await mkdtemp(path.join(tmpdir(), "atlas-test-run-"));
      const args = [...profile.args];
      if (profile.kind === "vitest" && !args.includes("run")) args.push("--run");
      if (profile.kind === "jest") args.push("--watch=false", "--runInBand");
      if (coverage) {
        if (profile.kind === "vitest") args.push("--coverage", "--coverage.reporter=lcov", `--coverage.reportsDirectory=${temp}`);
        if (profile.kind === "jest") args.push("--coverage", "--coverageReporters=lcov", `--coverageDirectory=${temp}`);
        if (profile.kind === "pytest") args.push("--cov", `--cov-report=lcov:${path.join(temp, "lcov.info")}`);
      }
      result.command = [profile.command, ...args.slice(profile.args.length)].join(" ");
      const before = new Map<string, string>();
      if (coverage) for (const source of sources) {
        try { const live = await safeFile(root, source.path); if (live === source.content) before.set(source.path, hashSource(live)); } catch { /* Changed/unavailable sources cannot be mapped. */ }
      }
      if (controller.signal.aborted) { outcome = "cancelled"; return; }
      outcome = await new Promise<TestRunResult["status"]>((resolve) => {
        const child = spawn(profile.executable, args, { cwd: root, env: childEnvironment(), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        let reason: "cancelled" | "timed-out" | undefined;
        let launchFailed = false;
        const stop = (why: "cancelled" | "timed-out") => {
          reason ??= why;
          if (process.platform === "win32" && child.pid) {
            const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
            killer.on("error", () => child.kill());
          } else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
        };
        const timer = setTimeout(() => stop("timed-out"), timeoutMs);
        const abort = () => stop("cancelled");
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        const append = (chunk: string) => {
          const clean = chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
          const remaining = 128_000 - result.output.length;
          result.output += clean.slice(0, remaining);
          if (clean.length > remaining) result.truncated = true;
        };
        child.stdout.setEncoding("utf8").on("data", append);
        child.stderr.setEncoding("utf8").on("data", append);
        child.once("error", () => { launchFailed = true; result.output += "\n无法启动测试程序，请检查已有运行环境。"; });
        child.once("close", (code) => {
          clearTimeout(timer); controller.signal.removeEventListener("abort", abort);
          result.exitCode = code;
          resolve(reason ?? (launchFailed ? "error" : code === 0 ? "passed" : code === null ? "error" : "failed"));
        });
      });
      if (coverage && !controller.signal.aborted && outcome !== "timed-out") {
        try {
          const parsed = parseLcov(await safeFile(temp, "lcov.info", 8_000_000), root);
          const mapped: CoverageFile[] = [];
          let omitted = 0;
          for (const file of parsed) {
            try {
              const sourceHash = before.get(file.path);
              if (!sourceHash || hashSource(await safeFile(root, file.path)) !== sourceHash) { omitted++; continue; }
              mapped.push({ ...file, sourceHash });
            } catch { omitted++; }
          }
          result.coverage = mapped;
          result.coverageNote = `本次测试集合的行覆盖率；不代表单个测试的覆盖或调用顺序。${omitted ? ` ${omitted} 个文件因未导入、源码变化或路径限制未映射，请重新扫描后再运行。` : ""}`;
          if (!mapped.length) result.coverageNote += " 没有可映射到已导入源码的覆盖数据。";
        } catch { result.coverageNote = "未生成有效 LCOV 报告；请检查 runner 的覆盖率支持与已有依赖，应用不会自动安装。"; }
      }
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
      if (controller.signal.aborted) outcome = "cancelled";
      if (coverage && (outcome === "cancelled" || outcome === "timed-out")) result.coverageNote = "测试已停止或超时，未展示不完整的覆盖率。";
      result.status = outcome;
      result.finishedAt = Date.now();
    }
  }
}
