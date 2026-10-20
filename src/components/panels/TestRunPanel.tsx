"use client";

import { useCallback, useEffect, useState } from "react";
import type { SymbolDetail } from "@/lib/api-types";
import type { TestRunState, TraceCall } from "@/lib/test-run-types";

const STATUS = { running: "运行中", passed: "运行成功", failed: "运行失败", cancelled: "已停止", "timed-out": "已超时", error: "启动或运行异常" };

function short(value: string, limit = 44): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function TraceNode({ call, depth }: { call: TraceCall; depth: number }) {
  return <li className="text-xs">
    <div className="break-all text-slate-300" style={{ paddingLeft: depth * 12 }}>
      <span className="text-slate-100">{call.func}</span>({call.args.map((a) => `${a.name}=${short(a.value)}`).join(", ")})
      {call.ret !== null && <span className="text-slate-400"> → {short(call.ret, 32)}</span>}
      <span className="text-slate-500"> · L{call.line}</span>
    </div>
    {call.children.length > 0 && <ul>{call.children.map((child) => <TraceNode key={child.id} call={child} depth={depth + 1} />)}</ul>}
  </li>;
}

export function TestRunPanel({ projectId, detail }: { projectId: number; detail: SymbolDetail }) {
  const [state, setState] = useState<TestRunState | null>(null);
  const [profileId, setProfileId] = useState("");
  const [coverage, setCoverage] = useState(false);
  const [trace, setTrace] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState(0);
  const endpoint = `/api/projects/${projectId}/test-runs`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const reply = await fetch(`${endpoint}?symbolId=${detail.symbol.id}`, { headers: { "content-type": "application/json" }, cache: "no-store", signal });
    const body = await reply.json();
    if (!reply.ok) throw new Error(body.error ?? "读取测试状态失败");
    setState(body);
    setObservedAt(Date.now());
    setError("");
  }, [endpoint, detail.symbol.id]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "读取失败"); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  const selected = state?.profiles.find((p) => p.id === profileId) ?? state?.profiles[0];
  const run = state?.run;
  const running = !!run && !run.finishedAt;
  const mapped = run?.coverage.find((f) => f.path === detail.file.path);
  const lines = mapped?.lines.filter((l) => l.line >= detail.symbol.startLine && l.line <= detail.symbol.endLine) ?? [];
  const hits = lines.filter((l) => l.hits > 0).length;
  const source = detail.file.content.split(/\r?\n/);

  async function act(action: "run" | "stop") {
    setBusy(true); setError("");
    try {
      const reply = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "stop" ? { action, runId: run?.id } : { action, profileId: selected?.id, command: selected?.command, coverage: coverage && selected?.coverage, trace: trace && selected?.kind === "pytest", symbolId: detail.symbol.id, confirmExecution: confirmed }) });
      const body = await reply.json();
      if (!reply.ok) throw new Error(body.error ?? "测试操作失败");
      if (action === "run") setConfirmed(false);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "测试操作失败"); }
    finally { setBusy(false); }
  }

  return <section className="mb-5 space-y-3 rounded-xl border border-slate-800 p-3" aria-label="测试执行">
    <h3 className="text-sm font-medium text-slate-100">本地测试执行</h3>
    <p className="text-xs leading-5 text-slate-400">手动运行项目已有测试集合，执行当前磁盘源码。切换面板后继续运行，最长 120 秒；服务重启会丢失状态。不自动安装依赖，不修改源码或配置。测试及其配置仍可能访问网络、写文件或数据库。</p>
    {!state && !error && <p className="text-xs text-slate-400">正在读取测试配置…</p>}
    {state?.reason && <p className="text-xs leading-5 text-slate-400">{state.reason}</p>}
    {!!state?.profiles.length && <>
      <label className="block text-xs text-slate-400">项目测试命令
        <select aria-label="项目测试命令" className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-100" value={selected?.id ?? ""} disabled={busy || running} onChange={(e) => { setProfileId(e.target.value); setConfirmed(false); }}>
          {state.profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <pre className="overflow-auto whitespace-pre-wrap break-all text-xs text-slate-400">{selected?.command}</pre>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-400"><input className="mt-1" type="checkbox" checked={coverage && !!selected?.coverage} disabled={!selected?.coverage || busy || running} onChange={(e) => setCoverage(e.target.checked)} />收集本次行覆盖率（需要 runner 已有覆盖率依赖；Node runner 暂不支持）</label>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-400"><input className="mt-1" type="checkbox" checked={trace && selected?.kind === "pytest"} disabled={selected?.kind !== "pytest" || busy || running} onChange={(e) => setTrace(e.target.checked)} />记录当前方法在测试中的每次调用（仅 pytest；记录接收者与参数，测试会慢约 3 倍）</label>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-400"><input className="mt-1" type="checkbox" checked={confirmed} disabled={busy || running} onChange={(e) => setConfirmed(e.target.checked)} />我信任该项目及其测试配置，确认执行本地代码</label>
      <div className="flex gap-2">
        <button className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-100 disabled:opacity-40" disabled={busy || running || !confirmed} onClick={() => void act("run")}>运行项目测试</button>
      </div>
    </>}
    {running && <button className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-100 disabled:opacity-40" disabled={busy} onClick={() => void act("stop")}>停止测试</button>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {run && <div className="space-y-2" aria-live="polite">
      <p className="text-xs text-slate-100">{running ? "运行中" : STATUS[run.status]} · {new Date(run.startedAt).toLocaleTimeString()} · {Math.max(0, ((run.finishedAt ?? observedAt) - run.startedAt) / 1000).toFixed(1)} 秒{run.exitCode !== null ? ` · 退出码 ${run.exitCode}` : ""}</p>
      <details><summary className="cursor-pointer text-xs text-slate-400">实际执行命令</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs text-slate-400">{run.command}</pre></details>
      <pre aria-label="测试输出" className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900 p-2 text-xs text-slate-300">{run.output || "等待测试输出…"}{run.truncated ? "\n（输出已截断）" : ""}</pre>
      <p className="text-xs leading-5 text-slate-400">{run.coverageNote}</p>
      {!!lines.length && <details open><summary className="cursor-pointer text-xs text-slate-100">当前方法：{hits}/{lines.length} 个报告行命中（{Math.round(hits / lines.length * 100)}%）</summary>
        <pre aria-label="当前方法行覆盖率" className="mt-2 max-h-64 overflow-auto text-xs">{lines.slice(0, 500).map((l) => <div key={l.line} className={l.hits > 0 ? "text-green-500" : "text-red-400"}>{l.hits > 0 ? "命中" : "未中"} {l.line} · {l.hits} 次 │ {source[l.line - 1] ?? ""}</div>)}</pre>
        {lines.length > 500 && <p className="text-xs text-slate-400">仅展示前 500 行，统计包含全部报告行。</p>}
      </details>}
      {!running && !lines.length && <p className="text-xs text-slate-400">当前方法没有可匹配的覆盖率数据：可能未采集、未包含此文件，或磁盘源码与导入版本已变化。这不表示覆盖率为 0。</p>}
      {run.trace && <details open>
        <summary className="cursor-pointer text-xs text-slate-100">调用记录：{run.trace.target.func} 在本次测试中被调用 {run.trace.calls} 次{run.trace.truncated ? "（已截断）" : ""}</summary>
        {run.trace.note && <p className="mt-1 text-xs leading-5 text-slate-400">{run.trace.note}</p>}
        {!!run.trace.roots.length && <ul aria-label="调用记录" className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-2">
          {run.trace.roots.slice(0, 120).map((call) => <TraceNode key={call.id} call={call} depth={0} />)}
        </ul>}
        {run.trace.roots.length > 120 && <p className="text-xs text-slate-400">仅展示前 120 条，统计包含全部记录。</p>}
      </details>}
    </div>}
  </section>;
}
