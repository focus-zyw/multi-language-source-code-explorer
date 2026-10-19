"use client";

import { useEffect, useState } from "react";
import type { ProjectEntries, ProjectEntryGroup } from "@/lib/api-types";

interface Props { projectId: number; projectName: string; onExplore: (id: number) => void }

function EntryGroup({ group, onExplore }: { group: ProjectEntryGroup; onExplore: (id: number) => void }) {
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(12);
  return (
    <li className="relative before:absolute before:-left-5 before:top-5 before:w-5 before:border-t before:border-dashed before:border-slate-700">
      <button onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-left hover:border-indigo-500/60">
        <span className="w-4 text-indigo-300">{open ? "−" : "+"}</span>
        <span className="text-sm font-semibold text-slate-100">{group.label}</span>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{group.entries.length}</span>
        <span className="ml-auto hidden text-xs text-slate-500 lg:inline">导航分组</span>
      </button>
      {open && <div className="ml-5 border-l border-dashed border-slate-700 pb-2 pl-5">
        <p className="py-2 text-xs leading-5 text-slate-500">{group.description}</p>
        <ul className="space-y-2">
          {group.entries.slice(0, limit).map((entry) => <li key={entry.symbol.id} className="relative before:absolute before:-left-5 before:top-5 before:w-5 before:border-t before:border-dashed before:border-slate-700">
            <button onClick={() => onExplore(entry.symbol.id)} className="group w-full rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 text-left hover:border-indigo-400/70 hover:bg-indigo-500/10">
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-all text-sm font-medium text-slate-100">{entry.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${entry.confidence === "heuristic" ? "bg-amber-500/10 text-amber-300" : "bg-sky-500/10 text-sky-300"}`}>{entry.confidence === "heuristic" ? "候选" : "约定识别"}</span>
                <span className="ml-auto shrink-0 text-xs text-indigo-300 group-hover:text-slate-100">探索调用 →</span>
              </span>
              <span className="mt-1 block break-all text-xs text-slate-400">{entry.symbol.filePath}:L{entry.symbol.line} · {entry.symbol.name}</span>
              <span className="mt-1 block text-xs leading-5 text-slate-500">{entry.reason}</span>
            </button>
          </li>)}
        </ul>
        {limit < group.entries.length && <button onClick={() => setLimit((value) => value + 20)} className="mt-3 rounded border border-slate-700 px-3 py-1.5 text-xs text-indigo-300 hover:bg-slate-800">再显示 20 个（还有 {group.entries.length - limit} 个）</button>}
      </div>}
    </li>
  );
}

export function ProjectOverview({ projectId, projectName, onExplore }: Props) {
  const [state, setState] = useState<{ data?: ProjectEntries; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/projects/${projectId}/entries`, { signal: ac.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "入口加载失败"); return body as ProjectEntries; })
      .then((data) => { if (!ac.signal.aborted) setState({ data }); })
      .catch((error: unknown) => { if (!ac.signal.aborted) setState({ error: error instanceof Error ? error.message : "入口加载失败" }); });
    return () => ac.abort();
  }, [projectId, attempt]);

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label="项目入口总览">
      <div className="border-b border-slate-800 bg-slate-950/70 px-6 py-3 text-sm text-slate-200">项目总览 <span className="ml-2 text-xs text-slate-500">从入口开始探索</span></div>
      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="rounded-xl border border-indigo-500/50 bg-indigo-500/10 px-5 py-4">
          <span className="text-xs text-indigo-300">项目总起点 · 虚拟导航节点</span>
          <h2 className="mt-1 break-all text-lg font-semibold text-slate-100">{projectName}</h2>
          <p className="mt-2 text-xs leading-5 text-slate-400">按入口类型选择一条路径，再进入方法调用树。下方虚线表示导航归属，不表示程序执行顺序或方法调用。</p>
          {state.data && <p className="mt-2 text-xs text-slate-400">识别到 {state.data.entryCount} 个入口 / 候选 · {state.data.groups.length} 个分组 · 点击方法继续探索</p>}
        </div>
        {state.error ? <div role="alert" className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">{state.error}<button onClick={() => { setState({}); setAttempt((value) => value + 1); }} className="ml-3 underline">重新加载</button></div>
          : !state.data ? <p role="status" className="mt-6 text-sm text-slate-500">正在识别项目入口…</p>
          : state.data.entryCount === 0 ? <div className="mt-5 rounded-lg border border-slate-800 p-5 text-sm leading-6 text-slate-400">暂未识别到可展示的入口。可从左侧选择任意函数或方法开始探索；动态注册、模块顶层脚本和部分框架入口可能无法识别。</div>
          : <ul className="ml-5 space-y-4 border-l border-dashed border-slate-700 py-5 pl-5">{state.data.groups.map((group) => <EntryGroup key={group.id} group={group} onExplore={onExplore} />)}</ul>}
        <p className="mt-4 text-xs leading-5 text-slate-500">入口识别基于导入时的静态快照，不会运行项目。可能遗漏动态入口；也可从左侧选择任意方法，手动确定探索起点。</p>
      </div>
    </main>
  );
}
