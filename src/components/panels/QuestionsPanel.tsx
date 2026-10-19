"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SymbolDetail } from "@/lib/api-types";
import type { QuestionQuote } from "@/lib/question-types";
import { questionCitation } from "@/lib/question-types";
import { questionTasks, questionTaskKey } from "@/lib/question-tasks";
import { explanationTaskKey, explanationTasks } from "@/lib/explanation-tasks";
import { Markdown } from "../Markdown";
import { CopyQuestionContext } from "../CopyQuestionContext";

const drafts = new Map<string, { text: string; quote: QuestionQuote | null; related: number[] }>();

export function QuestionsPanel({ projectId, detail, quote, onClearQuote, onSource }: { projectId: number; detail: SymbolDetail; quote: QuestionQuote | null; onClearQuote: () => void; onSource: (id: number, start: number, end: number) => void }) {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const choice = params.get("ai");
  const backend = choice === "api" || choice === "agent" ? choice : detail.ai.defaultBackend;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2">
      <label htmlFor="question-backend" className="text-xs text-slate-400">问答来源</label>
      <select id="question-backend" value={backend} onChange={(event) => { const next = new URLSearchParams(params.toString()); next.set("ai", event.target.value); router.replace(`${pathname}?${next}`, { scroll: false }); }} className="min-w-0 rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-slate-200">
        <option value="api">模型 API{detail.ai.backends.api.available ? "" : "（未配置）"}</option>
        <option value="agent">Codex{detail.ai.backends.agent.available ? "" : "（未检测到）"}</option>
      </select>
      <span className="truncate text-xs text-slate-500" title={detail.symbol.qualifiedName}>{detail.symbol.name}</span>
    </div>
    <Conversation key={backend} projectId={projectId} detail={detail} backend={backend} quote={quote} onClearQuote={onClearQuote} onSource={onSource} />
  </div>;
}

function Conversation({ projectId, detail, backend, quote: incoming, onClearQuote, onSource }: Parameters<typeof QuestionsPanel>[0] & { backend: "api" | "agent" }) {
  const key = questionTaskKey(projectId, detail.symbol.id, backend);
  const [draft, setDraft] = useState(() => drafts.get(key) ?? { text: "", quote: null as QuestionQuote | null, related: [] as number[] });
  const quote = incoming ?? draft.quote;
  const tasks = useSyncExternalStore(questionTasks.subscribe, questionTasks.getSnapshot, questionTasks.getServerSnapshot);
  const explanations = useSyncExternalStore(explanationTasks.subscribe, explanationTasks.getSnapshot, explanationTasks.getServerSnapshot);
  const task = tasks.find((item) => item.key === key);
  const explanation = explanations.find((item) => item.key === explanationTaskKey(projectId, detail.symbol.id, backend))?.result ?? detail.ai.explanations[backend];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { void questionTasks.load(projectId, detail.symbol.id, backend); }, [projectId, detail.symbol.id, backend]);
  useEffect(() => { drafts.set(key, { ...draft, quote }); }, [key, draft, quote]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "auto" }); }, [task?.history?.turns.length, task?.loading]);
  const related = useMemo(() => [...new Map(detail.outgoing.flatMap((call) => call.targets).filter((target) => target.symbolId !== detail.symbol.id).map((target) => [target.symbolId, target])).values()].slice(0, 30), [detail]);
  const update = (patch: Partial<typeof draft>) => setDraft((value) => ({ ...value, ...patch }));
  const send = () => {
    if (!draft.text.trim() || !task?.history || task.loading || task.refreshing) return;
    const input = { backend, question: draft.text.trim(), quote, relatedIds: draft.related, fingerprint: task.history.fingerprint, requestId: crypto.randomUUID() };
    const submitted = draft.text;
    void questionTasks.start(projectId, detail.symbol.id, input).then(() => {
      if (questionTasks.get(key)?.phase !== "已保存") return;
      const saved = drafts.get(key);
      if (saved?.text === submitted) {
        const next = { ...saved, text: "", quote: null };
        drafts.set(key, next);
        setDraft((current) => current.text === submitted ? next : current);
      }
    });
    // Failed/stopped questions remain available for retry; successful sends clear.
    onClearQuote(); update({ quote });
  };
  return <>
    <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
      <p className="text-xs leading-5 text-slate-500">围绕当前方法追问。切换方法或页签不会停止回答；仅手动停止会取消。记录保存在本机，刷新或关闭页面会中断未完成请求。</p>
      {!task?.history && <p className="text-slate-400">{task?.error ?? "正在读取对话…"}</p>}
      {task?.history?.turns.length === 0 && <div className="space-y-3 py-4 text-slate-400"><p>还没有对话。可以选中代码或讲解后点击“问 AI”，也可以直接提问当前方法。</p><button onClick={() => update({ text: "给一个具体输入，带我走一遍这个方法，并引用源码说明。" })} className="rounded border border-slate-700 px-3 py-2 text-left text-xs hover:bg-slate-800">用一个例子带我读懂</button></div>}
      {task?.history?.turns.map((turn) => <article key={turn.id} className="atlas-question space-y-2">
        {turn.outdated && <p className="text-xs text-amber-200">旧上下文：源码或依赖事实已变化。此轮仅供回看，不自动用于继续提问。</p>}
        <p className="atlas-question-prompt whitespace-pre-wrap break-words font-medium text-slate-100">{turn.question}</p>
        {turn.quote && <details className="text-xs text-slate-400"><summary className="cursor-pointer">引用的{turn.quote.kind === "code" ? "代码" : "讲解"}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{turn.quote.text}</pre></details>}
        {turn.answer ? <Markdown text={turn.answer} onSourceLink={(href) => {
          if (turn.outdated) return null;
          const link = questionCitation(href, turn.sources);
          return link ? () => onSource(link.source.symbolId, link.startLine, link.endLine) : null;
        }} /> : <p className="text-xs text-slate-500">{turn.status === "cancelled" ? "此轮已停止" : turn.status === "failed" ? "此轮回答失败" : task.loading ? "此轮正在回答…" : "此轮未完成，可重新发送问题"}</p>}
        <p className="text-[11px] text-slate-500">{turn.model ?? (backend === "agent" ? "Codex" : "模型 API")} · {new Date(turn.createdAt).toLocaleString("zh-CN")}</p>
      </article>)}
      {task?.loading && <div role="status" className="text-xs text-indigo-200">{task.pending?.question}<p className="mt-2">{task.phase}…可继续浏览，完成后保存。</p></div>}
      {task?.error && <p role="alert" className="break-words text-xs text-rose-300">{task.error}</p>}
      {!task?.loading && task?.phase === "已停止" && <p className="text-xs text-slate-400">已停止本次回答。</p>}
    </div>
    <div className="atlas-composer shrink-0 space-y-2 p-3">
      {quote && <div className="rounded border border-slate-700 p-2 text-xs text-slate-400"><div className="flex justify-between"><span title="选区超过 6000 字时只引用前 6000 字">引用{quote.kind === "code" ? "代码" : "讲解"}{quote.startLine ? ` · L${quote.startLine}–${quote.endLine}` : ""}</span><button aria-label="移除引用" onClick={() => { onClearQuote(); update({ quote: null }); }} className="px-1 text-slate-300">×</button></div><p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">{quote.text}</p></div>}
      <details className="text-xs text-slate-400"><summary className="cursor-pointer py-1">补充相关方法（最多 3 个）{draft.related.length ? ` · 已选 ${draft.related.length}` : ""}</summary><div className="max-h-40 space-y-2 overflow-auto py-2">{related.length ? related.map((target) => <label key={target.symbolId} className="flex items-start gap-2"><input type="checkbox" checked={draft.related.includes(target.symbolId)} disabled={!draft.related.includes(target.symbolId) && draft.related.length >= 3} onChange={(event) => update({ related: event.target.checked ? [...draft.related, target.symbolId] : draft.related.filter((id) => id !== target.symbolId) })} /><span className="min-w-0 break-all">{target.name} · {target.filePath}</span></label>) : "未找到可补充的项目内调用目标；信息不足时请先定位相关方法。"}</div></details>
      <textarea aria-label="输入源码问题" value={draft.text} maxLength={4000} onChange={(event) => update({ text: event.target.value })} placeholder="对这段代码有什么疑问？" rows={3} className="w-full resize-y rounded border border-slate-600 bg-slate-900 p-2 text-sm text-slate-100 outline-none focus:border-indigo-400" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); send(); } }} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <details className="relative text-xs text-slate-400"><summary className="cursor-pointer rounded px-2 py-1 hover:bg-slate-800">更多</summary><div className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-64 overflow-auto rounded border border-slate-700 bg-slate-900 p-2"><CopyQuestionContext detail={detail} backend={backend} explanation={explanation} generating={false} related={{ projectId, ids: draft.related }} extraText={`${quote ? `\n引用的${quote.kind === "code" ? "代码" : "讲解"}：\n${quote.text}` : ""}\n${draft.text}`} /><button className="mt-2 px-2 py-1 text-xs hover:text-slate-100" onClick={() => void questionTasks.load(projectId, detail.symbol.id, backend)}>刷新对话记录</button></div></details>
        {task?.loading ? <button onClick={() => questionTasks.stop(key)} className="rounded border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800">停止回答</button> : <button onClick={send} disabled={!draft.text.trim() || !task?.history || task.refreshing || !detail.ai.backends[backend].available} className="atlas-primary px-4 py-2 text-xs">发送问题</button>}
      </div>
      {!detail.ai.backends[backend].available && <p className="text-xs text-amber-200">当前来源未配置，可切换来源或通过“更多”复制上下文到外部提问。</p>}
      <p className="text-[10px] leading-4 text-slate-500">Ctrl/⌘+Enter 发送。显示最近 40 轮；每次最多携带 8 轮有效对话及选中的补充方法，超长内容限量提供。</p>
    </div>
  </>;
}
