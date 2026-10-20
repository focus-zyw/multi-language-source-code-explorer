"use client";
import Link from "next/link";
import { useState } from "react";
import type { TraceNode, TraceRun } from "@/lib/trace/types";

const SAMPLE = `def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)
`;

/** 参数值可能很长，界面上只保留开头，完整值放在 title 里。 */
function short(value: string, limit = 40): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function Node({ node }: { node: TraceNode }) {
  return (
    <li style={{ listStyle: "none" }}>
      <div className="flex items-baseline gap-2 whitespace-nowrap py-1" title={node.args.map((arg) => `${arg.name}=${arg.value}`).join(", ")}>
        <span className="text-[13px]" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "var(--atlas-text)" }}>
          {node.name}({node.args.map((arg) => `${arg.name}=${short(arg.value)}`).join(", ")})
        </span>
        {node.ret !== null ? <span className="text-[12px]" style={{ color: "var(--atlas-muted)" }}>→ {short(node.ret, 32)}</span> : null}
        <span className="text-[11px]" style={{ color: "var(--atlas-muted)" }}>L{node.line}</span>
      </div>
      {node.children.length > 0 ? (
        <ul style={{ borderLeft: "1px solid var(--atlas-border)", marginLeft: 6, paddingLeft: 16 }}>
          {node.children.map((child) => <Node key={child.id} node={child} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function TraceWorkbench() {
  const [code, setCode] = useState(SAMPLE);
  const [entry, setEntry] = useState("fib");
  const [argsText, setArgsText] = useState("[5]");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<TraceRun | null>(null);

  async function execute() {
    setError("");
    let args: unknown;
    try {
      args = JSON.parse(argsText.trim() || "[]");
    } catch {
      setError("参数必须是合法 JSON，例如 [5] 或 [[3, 1, 2]]");
      return;
    }
    if (!Array.isArray(args)) {
      setError("参数必须是 JSON 数组，元素会按顺序传给入口函数");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/trace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, entry, args }) });
      const data = await response.json() as TraceRun & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "追踪失败");
      setRun(data);
    } catch (cause) {
      setRun(null);
      setError(cause instanceof Error ? cause.message : "追踪失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1400px] flex-col gap-4 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium" style={{ color: "var(--atlas-text)" }}>调用树追踪</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--atlas-muted)" }}>
            粘贴一段 Python 代码，选中入口函数并传入参数，得到一棵带实参和返回值的真实调用树。
          </p>
        </div>
        <Link href="/" className="text-[13px] underline" style={{ color: "var(--atlas-muted)" }}>返回项目列表</Link>
      </header>

      <div className="rounded-lg border px-4 py-3 text-[12px]" style={{ borderColor: "var(--atlas-ref-heuristic)", background: "var(--atlas-surface)", color: "var(--atlas-text)" }}>
        这段代码会被真实执行，包括 import 与任何副作用。只在你自己信任的代码上运行；执行环境是临时目录，没有沙箱隔离。
      </div>

      <div className="grid flex-1 gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-xl border p-4" style={{ borderColor: "var(--atlas-border)", background: "var(--atlas-surface)" }}>
          <label className="text-[12px]" style={{ color: "var(--atlas-muted)" }}>源码</label>
          <textarea
            value={code}
            onChange={(event) => setCode(event.target.value)}
            spellCheck={false}
            className="min-h-[320px] flex-1 resize-y rounded-lg border p-3 text-[13px] leading-6 outline-none"
            style={{ borderColor: "var(--atlas-border)", background: "var(--atlas-canvas)", color: "var(--atlas-text)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--atlas-muted)" }}>
              入口函数
              <input value={entry} onChange={(event) => setEntry(event.target.value)} className="rounded-lg border px-3 py-2 text-[13px] outline-none"
                style={{ borderColor: "var(--atlas-border)", background: "var(--atlas-canvas)", color: "var(--atlas-text)", fontFamily: "ui-monospace, monospace" }} />
            </label>
            <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--atlas-muted)" }}>
              参数（JSON 数组）
              <input value={argsText} onChange={(event) => setArgsText(event.target.value)} className="rounded-lg border px-3 py-2 text-[13px] outline-none"
                style={{ borderColor: "var(--atlas-border)", background: "var(--atlas-canvas)", color: "var(--atlas-text)", fontFamily: "ui-monospace, monospace" }} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--atlas-muted)" }}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我知道这会真实执行上面的代码
          </label>
          <button type="button" onClick={execute} disabled={busy || !confirmed}
            className="rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-40"
            style={{ background: "var(--atlas-clay)", color: "#fff" }}>
            {busy ? "正在执行…" : "运行并追踪"}
          </button>
          {error ? <p className="text-[12px]" style={{ color: "var(--atlas-ref-unresolved)" }}>{error}</p> : null}
        </section>

        <section className="flex min-h-[320px] flex-col gap-3 rounded-xl border p-4" style={{ borderColor: "var(--atlas-border)", background: "var(--atlas-surface)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[12px]" style={{ color: "var(--atlas-muted)" }}>调用树</span>
            {run ? (
              <span className="text-[11px]" style={{ color: "var(--atlas-muted)" }}>
                {run.nodeCount} 个节点 · {run.elapsedMs} ms{run.truncated ? " · 已达节点上限，树被截断" : ""}
              </span>
            ) : null}
          </div>

          {run?.error ? (
            <p className="text-[12px]" style={{ color: "var(--atlas-ref-unresolved)" }}>执行中断：{run.error}</p>
          ) : null}
          {run?.result !== null && run?.result !== undefined ? (
            <p className="text-[12px]" style={{ color: "var(--atlas-muted)" }}>返回值：<span style={{ color: "var(--atlas-text)" }}>{run.result}</span></p>
          ) : null}
          {run?.stdout ? (
            <pre className="max-h-32 overflow-auto rounded-lg p-2 text-[11px]" style={{ background: "var(--atlas-canvas)", color: "var(--atlas-muted)" }}>{run.stdout}</pre>
          ) : null}

          {run?.tree ? (
            <ul className="overflow-auto">{<Node node={run.tree} />}</ul>
          ) : (
            <p className="my-auto text-[12px]" style={{ color: "var(--atlas-muted)" }}>
              {run ? "没有捕获到调用，检查入口函数是否被真正执行。" : "运行后在这里显示调用树。"}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
