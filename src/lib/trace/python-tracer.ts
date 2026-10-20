import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TraceArg, TraceNode, TraceRun } from "./types.ts";

export class TraceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MAX_CODE_CHARS = 20_000;
const MAX_ARGS_CHARS = 4_000;
const MAX_NODES = 500;
const MAX_DEPTH = 40;
const MAX_REPR = 120;
const MAX_STDOUT = 4_000;
const MAX_STDERR = 8_000;
const TIMEOUT_MS = 8_000;
const ENTRY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 驱动程序：只负责把 snippet.py 的入口函数跑一次，并把 call/return 事件折叠成树。
 * 结果写入 trace.json 而不是 stdout，避免被用户代码的 print 污染。
 */
const DRIVER = String.raw`
import importlib.util
import io
import json
import os
import sys

cfg = json.loads(sys.argv[1])
entry = cfg["entry"]
call_args = cfg["args"]
max_nodes = cfg["maxNodes"]
max_depth = cfg["maxDepth"]
max_repr = cfg["maxRepr"]
max_stdout = cfg["maxStdout"]
target = os.path.abspath("snippet.py")

nodes = 0
truncated = False
root = [None]
stack = []


class Limited(io.TextIOBase):
    def __init__(self, limit):
        self.limit = limit
        self.parts = []
        self.size = 0

    def write(self, text):
        if self.size < self.limit:
            chunk = text[: self.limit - self.size]
            self.parts.append(chunk)
            self.size += len(chunk)
        return len(text)

    def getvalue(self):
        return "".join(self.parts)


def safe_repr(value):
    try:
        text = repr(value)
    except BaseException:
        text = "<无法显示>"
    if len(text) > max_repr:
        text = text[:max_repr] + "..."
    return text


def tracer(frame, event, arg):
    global nodes, truncated
    if frame.f_code.co_filename != target:
        return None
    if event == "call":
        if nodes >= max_nodes or len(stack) >= max_depth:
            truncated = True
            return None
        nodes += 1
        node = {
            "id": nodes,
            "name": frame.f_code.co_name,
            "args": [{"name": key, "value": safe_repr(val)} for key, val in list(frame.f_locals.items())[:12]],
            "ret": None,
            "line": frame.f_lineno,
            "depth": len(stack),
            "children": [],
        }
        if stack:
            stack[-1][1]["children"].append(node)
        else:
            root[0] = node
        stack.append((frame, node))
        return tracer
    if event == "return":
        if stack and stack[-1][0] is frame:
            node = stack.pop()[1]
            if node["ret"] is None:
                node["ret"] = safe_repr(arg)
    return tracer


out = {"ok": True, "tree": None, "nodeCount": 0, "truncated": False, "result": None, "stdout": "", "error": None}
buffer = Limited(max_stdout)
saved = sys.stdout
try:
    spec = importlib.util.spec_from_file_location("snippet", target)
    module = importlib.util.module_from_spec(spec)
    sys.stdout = buffer
    spec.loader.exec_module(module)
    fn = getattr(module, entry, None)
    if fn is None or not callable(fn):
        raise LookupError("找不到可调用的入口: " + entry)
    sys.settrace(tracer)
    out["result"] = safe_repr(fn(*call_args))
except BaseException as exc:
    out["ok"] = False
    out["error"] = type(exc).__name__ + ": " + str(exc)[:400]
finally:
    sys.settrace(None)
    sys.stdout = saved

out["tree"] = root[0]
out["nodeCount"] = nodes
out["truncated"] = truncated
out["stdout"] = buffer.getvalue()

with open("trace.json", "w", encoding="utf-8") as handle:
    json.dump(out, handle, ensure_ascii=False)
`;

function pythonExecutable(): string {
  if (process.env.ATLAS_PYTHON) return process.env.ATLAS_PYTHON;
  return process.platform === "win32" ? "python.exe" : "python3";
}

/** 只透传运行所需的环境变量，避免把密钥一类的配置带进被追踪的进程。 */
function childEnvironment(): NodeJS.ProcessEnv {
  // 被追踪的进程不需要 Node 的任何环境，这里只给 Python 运行时本身要用的变量。
  const env = { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } as unknown as NodeJS.ProcessEnv;
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/** 校验来自驱动程序的 JSON，避免把形状不对的数据直接送到界面。 */
function parseTree(value: unknown): TraceNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (typeof node.name !== "string" || typeof node.id !== "number") return null;
  const args: TraceArg[] = Array.isArray(node.args)
    ? node.args.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const arg = item as Record<string, unknown>;
        return typeof arg.name === "string" && typeof arg.value === "string" ? [{ name: arg.name, value: arg.value }] : [];
      })
    : [];
  return {
    id: node.id,
    name: node.name,
    args,
    ret: typeof node.ret === "string" ? node.ret : null,
    line: typeof node.line === "number" ? node.line : 0,
    depth: typeof node.depth === "number" ? node.depth : 0,
    children: Array.isArray(node.children) ? node.children.flatMap((child) => { const parsed = parseTree(child); return parsed ? [parsed] : []; }) : [],
  };
}

export interface TraceInput {
  code: string;
  entry: string;
  args: unknown[];
}

let running = 0;

/**
 * 在临时目录里真实执行一次用户提供的代码。这里没有沙箱：调用方必须已经得到用户的明确确认。
 */
export async function runPythonTrace(input: TraceInput): Promise<TraceRun> {
  const started = Date.now();
  if (!input.code.trim()) throw new TraceError("请先填入代码", 400);
  if (input.code.length > MAX_CODE_CHARS) throw new TraceError(`代码不能超过 ${MAX_CODE_CHARS} 个字符`, 413);
  if (!ENTRY_PATTERN.test(input.entry)) throw new TraceError("入口名必须是合法的 Python 标识符", 400);
  if (JSON.stringify(input.args).length > MAX_ARGS_CHARS) throw new TraceError("参数过大", 413);
  if (running >= 1) throw new TraceError("已有一次追踪正在运行", 429);

  running += 1;
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-trace-"));
  try {
    await writeFile(path.join(dir, "snippet.py"), input.code, "utf8");
    await writeFile(path.join(dir, "driver.py"), DRIVER, "utf8");
    const payload = JSON.stringify({ entry: input.entry, args: input.args, maxNodes: MAX_NODES, maxDepth: MAX_DEPTH, maxRepr: MAX_REPR, maxStdout: MAX_STDOUT });

    const outcome = await new Promise<{ code: number | null; stderr: string; timedOut: boolean; launchFailed: boolean }>((resolve) => {
      const child = spawn(pythonExecutable(), ["driver.py", payload], { cwd: dir, env: childEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let timedOut = false;
      let launchFailed = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, TIMEOUT_MS);
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });
      child.once("error", () => { launchFailed = true; clearTimeout(timer); resolve({ code: null, stderr, timedOut, launchFailed }); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut, launchFailed }); });
    });

    if (outcome.launchFailed) throw new TraceError("无法启动 Python，请确认本机已安装并在 PATH 中（或设置 ATLAS_PYTHON）", 503);
    if (outcome.timedOut) throw new TraceError(`执行超过 ${TIMEOUT_MS / 1000} 秒已终止，可能是死循环或数据量过大`, 504);

    let raw: string;
    try {
      raw = await readFile(path.join(dir, "trace.json"), "utf8");
    } catch {
      throw new TraceError(`追踪进程没有产出结果。${outcome.stderr.trim().slice(-400) || "请检查代码能否被 Python 3 解析"}`, 422);
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new TraceError("追踪结果格式异常", 502);
    const data = parsed as Record<string, unknown>;
    return {
      ok: data.ok === true,
      tree: parseTree(data.tree),
      nodeCount: typeof data.nodeCount === "number" ? data.nodeCount : 0,
      truncated: data.truncated === true,
      result: typeof data.result === "string" ? data.result : null,
      stdout: typeof data.stdout === "string" ? data.stdout : "",
      error: typeof data.error === "string" ? data.error : null,
      elapsedMs: Date.now() - started,
    };
  } finally {
    running -= 1;
    await rm(dir, { recursive: true, force: true });
  }
}
