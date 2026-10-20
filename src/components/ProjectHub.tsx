"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { ProjectInsights } from "@/lib/project-insights";
import { ProjectOverview } from "./ProjectOverview";
import { LearningOverview } from "./LearningOverview";
import { StructuredSearch } from "./StructuredSearch";

const DependencyExplorer = dynamic(() => import("./DependencyExplorer"), { ssr: false, loading: () => <p className="p-6 text-sm text-slate-500">正在加载依赖图…</p> });
export type OverviewSection = "entries" | "dependencies" | "learning" | "search";
interface Props { projectId: number; projectName: string; section: OverviewSection; onSection: (section: OverviewSection) => void; onExplore: (id: number) => void; onRead: (id: number) => void }

export function ProjectHub(props: Props) {
  const [state, setState] = useState<{ data?: ProjectInsights; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const needsInsights = props.section === "dependencies" || props.section === "learning";
  useEffect(() => {
    if (!needsInsights || state.data) return;
    const controller = new AbortController();
    fetch(`/api/projects/${props.projectId}/insights`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "项目分析加载失败"); return body as ProjectInsights;
    }).then((data) => { if (!controller.signal.aborted) setState({ data }); }).catch((error: unknown) => { if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : "项目分析加载失败" }); });
    return () => controller.abort();
  }, [props.projectId, needsInsights, attempt, state.data]);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <nav aria-label="项目总览视图" className="flex shrink-0 flex-wrap gap-2 border-b border-slate-800 bg-slate-950 px-5 py-3">
      {([["entries", "项目入口"], ["dependencies", "文件依赖"], ["learning", "学习导航"], ["search", "结构化搜索"]] as const).map(([id, label]) => <button key={id} aria-pressed={props.section === id} onClick={() => props.onSection(id)} className={`rounded-lg px-3 py-2 text-sm ${props.section === id ? "bg-indigo-500/15 text-indigo-200" : "text-slate-400 hover:bg-slate-800"}`}>{label}</button>)}
    </nav>
    {props.section === "entries" ? <ProjectOverview projectId={props.projectId} projectName={props.projectName} onExplore={props.onExplore} /> : <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5" aria-label={props.section === "dependencies" ? "文件依赖" : props.section === "search" ? "结构化搜索" : "学习导航"}>
      {props.section === "search" ? <StructuredSearch projectId={props.projectId} onRead={props.onRead} /> : state.error ? <div role="alert" className="text-sm text-rose-300">{state.error}<button onClick={() => { setState({}); setAttempt((value) => value + 1); }} className="ml-3 underline">重试</button></div> : !state.data ? <p role="status" className="text-sm text-slate-500">正在汇总项目静态快照…</p> : props.section === "dependencies" ? <DependencyExplorer data={state.data.dependencies} onRead={props.onRead} /> : <LearningOverview data={state.data.learning} scan={state.data.scan} onRead={props.onRead} />}
    </main>}
  </div>;
}
