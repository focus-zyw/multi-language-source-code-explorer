"use client";
import { useEffect, useState } from "react";
import { SEARCH_KINDS, SEARCH_LANGUAGES, type SymbolSearchResult } from "@/lib/symbol-search";
import { kindLabel } from "./Badges";
import { LANGUAGE_LABELS } from "@/lib/languages";

interface Props { projectId: number; onRead: (id: number) => void; request: string; onSearch: (request: string) => void }
const SORTS = [["path", "文件位置"], ["name", "符号名称"], ["complexity", "圈复杂度"], ["loc", "源码行数"], ["params", "参数数"], ["exactCallers", "确定调用方数"]] as const;
export function StructuredSearch({ projectId, onRead, request, onSearch }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ projectId: number; request: string; data?: SymbolSearchResult; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/projects/${projectId}/search?${request}`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "搜索失败"); return body as SymbolSearchResult;
    }).then((data) => { if (!controller.signal.aborted) setState({ projectId, request, data }); }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ projectId, request, error: error instanceof Error ? error.message : "搜索失败" });
    });
    return () => controller.abort();
  }, [projectId, request, attempt]);
  const shown = state?.request === request && state.projectId === projectId ? state : null;
  const values = new URLSearchParams(request);
  const inputClass = "mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm text-slate-200";
  const page = (value: number) => { const params = new URLSearchParams(request); params.set("page", String(value)); onSearch(params.toString()); };
  const data = shown?.data;
  return <div className="space-y-5">
    <p className="text-sm leading-6 text-slate-400">按已入库的静态字段组合筛选。基类/接口和注解为声明文本匹配，各语言提取范围不同。指标筛选或排序仅包含函数和方法；静态调用方数量不代表运行频率。</p>
    <form key={`${projectId}:${request}`} onSubmit={(event) => {
      event.preventDefault(); const fields = new FormData(event.currentTarget), params = new URLSearchParams();
      for (const [key, value] of fields) if (String(value).trim()) params.set(key, String(value).trim());
      const next = params.toString();
      if (next === request) setAttempt((value) => value + 1); else onSearch(next);
    }} className="grid gap-3 rounded-xl border border-slate-700 p-4 sm:grid-cols-2 xl:grid-cols-4">
      {([["q", "符号名称", "例如 handleRequest"], ["path", "文件路径", "例如 src/api"], ["decorator", "注解 / 装饰器文本", "例如 GetMapping、route"], ["base", "已记录的基类 / 接口文本", "例如 BaseService"]] as const).map(([name, label, placeholder]) => <label key={name} className="text-xs text-slate-400">{label}<input name={name} defaultValue={values.get(name) ?? ""} maxLength={name === "q" || name === "path" ? 200 : 100} placeholder={placeholder} className={inputClass} /></label>)}
      <label className="text-xs text-slate-400">类型<select name="kind" defaultValue={values.get("kind") ?? ""} className={inputClass}><option value="">全部类型</option>{SEARCH_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></label>
      <label className="text-xs text-slate-400">语言<select name="language" defaultValue={values.get("language") ?? ""} className={inputClass}><option value="">全部语言</option>{SEARCH_LANGUAGES.map((language) => <option key={language} value={language}>{LANGUAGE_LABELS[language]}</option>)}</select></label>
      <label className="text-xs text-slate-400">范围<select name="scope" defaultValue={values.get("scope") ?? "all"} className={inputClass}><option value="all">全部代码</option><option value="source">非测试代码</option><option value="tests">测试代码</option></select></label>
      {([["minCc", "圈复杂度下限"], ["maxCc", "圈复杂度上限"], ["minLoc", "源码行数下限"], ["maxLoc", "源码行数上限"], ["minParams", "参数数下限"], ["maxParams", "参数数上限"], ["minExactCallers", "确定调用方数下限"]] as const).map(([name, label]) => <label key={name} className="text-xs text-slate-400">{label}<input name={name} type="number" min={0} max={9999999} step={1} defaultValue={values.get(name) ?? ""} className={inputClass} /></label>)}
      <label className="text-xs text-slate-400">排序<select name="sort" defaultValue={values.get("sort") ?? "path"} className={inputClass}>{SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-xs text-slate-400">顺序<select name="order" defaultValue={values.get("order") ?? "asc"} className={inputClass}><option value="asc">升序</option><option value="desc">降序</option></select></label>
      <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" name="deprecated" value="1" defaultChecked={values.get("deprecated") === "1"} />仅弃用标记</label>
      <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" name="methodsOnly" value="1" defaultChecked={values.get("methodsOnly") === "1"} />仅函数和方法</label>
      <div className="flex gap-3"><button className="atlas-primary px-4 py-2 text-sm">搜索</button><button type="button" className="rounded border border-slate-700 px-3 py-2 text-xs" onClick={(event) => { event.currentTarget.form?.reset(); onSearch(""); }}>清空筛选</button></div>
    </form>
    {!shown ? <p role="status" className="text-sm text-slate-500">正在搜索静态快照…</p> : shown.error ? <p role="alert" className="text-sm text-rose-300">{shown.error}<button className="ml-3 underline" onClick={() => setAttempt((value) => value + 1)}>重试</button></p> : data && <>
      <p aria-live="polite" className="text-xs text-slate-500">共 {data.total} 项 · 每页 {data.pageSize} 项 · 第 {data.page + 1} 页</p>
      <ul className="space-y-2">{data.items.map((item) => <li key={item.id}><button onClick={() => onRead(item.id)} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-4 text-left hover:border-indigo-400">
        <span className="break-all text-sm font-semibold text-indigo-200">{item.name}</span><span className="ml-3 text-xs text-slate-400">{kindLabel(item.kind)}{item.deprecated ? " · 已有弃用标记" : ""}</span>
        <span className="mt-1 block break-all text-xs text-slate-500">{item.path}:L{item.line}</span>
        {item.complexity !== null && <span className="mt-2 block text-xs leading-5 text-slate-400">圈复杂度 {item.complexity} · 源码 {item.loc} 行 · 参数 {item.params} · 确定调用方 {item.exactCallers} · 推断 {item.inferredCallers} · 候选 {item.candidateCallers}</span>}
        {(item.decorators.length > 0 || item.bases.length > 0) && <span className="mt-2 block break-all text-xs leading-5 text-slate-400">{item.decorators.join(" · ")}{item.bases.length ? ` · 基类/接口：${item.bases.join("、")}` : ""}</span>}
      </button></li>)}</ul>
      {!data.items.length && <p className="rounded-xl border border-dashed border-slate-700 p-8 text-sm text-slate-400">没有符合条件的结果。可减少筛选条件；未被语言插件提取的事实不会出现在搜索中。</p>}
      <p className="text-xs leading-5 text-slate-500">调用方包含测试中的调用，按不同方法去重；确定、推断与候选分别计数，同一方法可能出现在多个类别。</p>
      <div className="flex gap-3 text-xs"><button disabled={data.page === 0} onClick={() => page(data.page - 1)} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">上一页</button><button disabled={(data.page + 1) * data.pageSize >= data.total} onClick={() => page(data.page + 1)} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">下一页</button></div>
    </>}
  </div>;
}
