"use client";
import { useEffect, useState } from "react";
import { SEARCH_KINDS, SEARCH_LANGUAGES, type SymbolSearchResult } from "@/lib/symbol-search";
import { kindLabel } from "./Badges";
import { LANGUAGE_LABELS } from "@/lib/languages";

export function StructuredSearch({ projectId, onRead }: { projectId: number; onRead: (id: number) => void }) {
  const [request, setRequest] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ request: string; data?: SymbolSearchResult; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/projects/${projectId}/search?${request}`, { signal: controller.signal }).then(async (response) => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "搜索失败"); return body as SymbolSearchResult;
    }).then((data) => { if (!controller.signal.aborted) setState({ request, data }); }).catch((error: unknown) => { if (!controller.signal.aborted) setState({ request, error: error instanceof Error ? error.message : "搜索失败" }); });
    return () => controller.abort();
  }, [projectId, request, attempt]);
  const shown = state?.request === request ? state : null;
  const inputClass = "mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm text-slate-200";
  const page = (value: number) => { const params = new URLSearchParams(request); params.set("page", String(value)); setRequest(params.toString()); };
  return <div className="space-y-5">
    <p className="text-sm leading-6 text-slate-400">按已入库的静态字段组合筛选。基类/接口是声明文本匹配，不保证查全接口实现或方法覆盖；各语言提取范围不同。弃用标记同时检查已提取的文档注释与注解，不把两者视为同一种语法。</p>
    <form onSubmit={(event) => { event.preventDefault(); const fields = new FormData(event.currentTarget), params = new URLSearchParams(); for (const [key, value] of fields) if (String(value).trim()) params.set(key, String(value).trim()); setRequest(params.toString()); setAttempt((value) => value + 1); }} className="grid gap-3 rounded-xl border border-slate-700 p-4 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-xs text-slate-400">符号名称<input name="q" maxLength={200} placeholder="例如 handleRequest" className={inputClass} /></label>
      <label className="text-xs text-slate-400">文件路径<input name="path" maxLength={200} placeholder="例如 src/api" className={inputClass} /></label>
      <label className="text-xs text-slate-400">类型<select name="kind" className={inputClass}><option value="">全部类型</option>{SEARCH_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></label>
      <label className="text-xs text-slate-400">语言<select name="language" className={inputClass}><option value="">全部语言</option>{SEARCH_LANGUAGES.map((language) => <option key={language} value={language}>{LANGUAGE_LABELS[language]}</option>)}</select></label>
      <label className="text-xs text-slate-400">注解 / 装饰器文本<input name="decorator" maxLength={100} placeholder="例如 GetMapping、route" className={inputClass} /></label>
      <label className="text-xs text-slate-400">已记录的基类 / 接口文本<input name="base" maxLength={100} placeholder="例如 BaseService" className={inputClass} /></label>
      <label className="text-xs text-slate-400">范围<select name="scope" className={inputClass}><option value="all">全部代码</option><option value="source">非测试代码</option><option value="tests">测试代码</option></select></label>
      <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" name="deprecated" value="1" />仅弃用标记</label><button className="atlas-primary px-4 py-2 text-sm">搜索</button></div>
    </form>
    {!shown ? <p role="status" className="text-sm text-slate-500">正在搜索静态快照…</p> : shown.error ? <p role="alert" className="text-sm text-rose-300">{shown.error}<button className="ml-3 underline" onClick={() => setAttempt((value) => value + 1)}>重试</button></p> : shown.data && <>
      <p className="text-xs text-slate-500">共 {shown.data.total} 项 · 每页 {shown.data.pageSize} 项 · 第 {shown.data.page + 1} 页</p>
      <ul className="space-y-2">{shown.data.items.map((item) => <li key={item.id}><button onClick={() => onRead(item.id)} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-4 text-left hover:border-indigo-400"><span className="break-all text-sm font-semibold text-indigo-200">{item.name}</span><span className="ml-3 text-xs text-slate-400">{kindLabel(item.kind)}{item.deprecated ? " · 已有弃用标记" : ""}</span><span className="mt-1 block break-all text-xs text-slate-500">{item.path}:L{item.line}</span>{(item.decorators.length > 0 || item.bases.length > 0) && <span className="mt-2 block break-all text-xs leading-5 text-slate-400">{item.decorators.join(" · ")}{item.bases.length ? ` · 基类/接口：${item.bases.join("、")}` : ""}</span>}</button></li>)}</ul>
      {!shown.data.items.length && <p className="rounded-xl border border-dashed border-slate-700 p-8 text-sm text-slate-400">没有符合条件的结果。可减少筛选条件；未被语言插件提取的事实不会出现在搜索中。</p>}
      <div className="flex gap-3 text-xs"><button disabled={shown.data.page === 0} onClick={() => page(shown.data!.page - 1)} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">上一页</button><button disabled={(shown.data.page + 1) * shown.data.pageSize >= shown.data.total} onClick={() => page(shown.data!.page + 1)} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">下一页</button></div>
    </>}
  </div>;
}
