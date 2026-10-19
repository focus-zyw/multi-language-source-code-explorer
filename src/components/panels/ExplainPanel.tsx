"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SymbolDetail } from "@/lib/api-types";
import type { AgentPhase, ExplanationBackend, ExplanationResult } from "@/lib/ai-types";
import { explanationTaskKey, explanationTasks } from "@/lib/explanation-tasks";
import { Chip, KindIcon, kindLabel } from "../Badges";
import { Markdown } from "../Markdown";
import { ReadingZoom } from "../ReadingZoom";
import { CopyQuestionContext } from "../CopyQuestionContext";
import { STRUCTURE_PAGE_SIZE } from "@/lib/structure-browsing";
import type { QuestionQuote } from "@/lib/question-types";

interface Props {
  projectId: number;
  detail: SymbolDetail;
  onNavigate: (id: number) => void;
  onAiUpdate: (symbolId: number, backend: ExplanationBackend, ai: ExplanationResult) => void;
  onAsk?: (quote: QuestionQuote | null) => void;
}

const PHASE_LABEL: Record<AgentPhase, string> = {
  starting: "正在启动本机 Agent",
  running: "Agent 正在处理，等待讲解结果",
  responding: "已收到讲解，正在完成生成",
  finishing: "生成已完成，正在收尾并保存",
};

export function ExplainPanel({ projectId, detail, onNavigate, onAiUpdate, onAsk }: Props) {
  const { symbol: s, summary, ai, file } = detail;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const choice = searchParams.get("ai");
  const backend: ExplanationBackend = choice === "api" || choice === "agent" ? choice : ai.defaultBackend;
  const selected = ai.backends[backend];
  const tasks = useSyncExternalStore(explanationTasks.subscribe, explanationTasks.getSnapshot, explanationTasks.getServerSnapshot);
  const taskKey = explanationTaskKey(projectId, s.id, backend);
  const currentRequest = tasks.find((task) => task.key === taskKey);
  const cached = currentRequest?.result ?? ai.explanations[backend];
  const [now, setNow] = useState(0);
  const loading = currentRequest?.loading ?? false;
  const error = currentRequest?.error ?? null;
  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [loading]);
  const [showImports, setShowImports] = useState(false);
  const [selection, setSelection] = useState<{ id: number; text: string } | null>(null);
  const [childrenPage, setChildrenPage] = useState({ id: s.id, limit: STRUCTURE_PAGE_SIZE });
  const childrenLimit = childrenPage.id === s.id ? childrenPage.limit : STRUCTURE_PAGE_SIZE;

  const generate = (force: boolean) => {
    setNow(Date.now());
    void explanationTasks.start({ projectId, symbolId: s.id, symbolName: s.qualifiedName, backend, force }, (result) => onAiUpdate(s.id, backend, result));
  };
  const stop = () => explanationTasks.stop(taskKey);
  const elapsedSeconds = currentRequest ? Math.max(0, Math.floor((now - currentRequest.startedAt) / 1000)) : 0;

  const structural = (s.kind === "element" || s.kind === "property");
  const m = s.metrics;
  const unresolvedImports = file.imports.filter((i) => i.kind === "unresolved");

  return (
    <ReadingZoom region="explanation">
    {(fontSize) => <div className="space-y-4 p-4" style={{ fontSize }} onMouseUp={(event) => {
      if ((event.target as Element).closest("button,select,input,textarea")) return;
      const selected = window.getSelection();
      if (selected?.anchorNode && selected.focusNode && event.currentTarget.contains(selected.anchorNode) && event.currentTarget.contains(selected.focusNode)) setSelection({ id: s.id, text: selected.toString().slice(0, 6000) });
    }}>
      <div>
        <div className="flex items-center gap-2">
          <KindIcon kind={s.kind} />
          <h2 className="min-w-0 flex-1 break-all text-[1.067em] font-semibold text-slate-100">{s.qualifiedName}</h2>
          {onAsk && <button onMouseDown={(event) => event.preventDefault()} onClick={() => onAsk(selection?.id === s.id && selection.text.trim() ? { kind: "explanation", text: selection.text } : null)} className="shrink-0 rounded px-2 py-1.5 text-xs text-indigo-300 hover:bg-slate-800" title="选中讲解后可引用提问；未选中则提问当前方法">问 AI</button>}
          <CopyQuestionContext compact key={taskKey} detail={detail} backend={backend} explanation={cached} generating={loading} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip tone="indigo">{kindLabel(s.kind)}</Chip>
          {s.isAsync && <Chip tone="amber">async</Chip>}
          {s.isGenerator && <Chip tone="amber">生成器</Chip>}
          {s.decorators.map((d) => (
            <Chip key={d} title="装饰器/注解">
              {d}
            </Chip>
          ))}
          <Chip title="行数">{m.loc} 行</Chip>
          {!structural && s.kind !== "class" && (
            <Chip tone={m.complexity > 10 ? "rose" : m.complexity > 5 ? "amber" : "emerald"} title="圈复杂度 = 1 + 分支 + 循环 + 异常处理 + 布尔运算">
              复杂度 {m.complexity}
            </Chip>
          )}
        </div>
        {detail.parent && (
          <button onClick={() => onNavigate(detail.parent!.id)} className="mt-2 text-xs text-indigo-300 hover:underline">
            ↑ 所属：{detail.parent.name}
          </button>
        )}
      </div>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[1em] font-semibold text-slate-200">静态摘要</h3>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400" title="由语法分析与度量直接生成，不含模型推测">
            语法分析生成 · 非 AI
          </span>
        </div>
        <p className="leading-[1.7] text-slate-200">{summary.headline}</p>
        <ul className="mt-2 space-y-1 leading-[1.7] text-slate-400">
          {summary.bullets.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-slate-500">•</span>
              <span className="min-w-0 break-words">{b}</span>
            </li>
          ))}
        </ul>
      </section>

      {s.docstring && (
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-1 text-[1em] font-semibold text-slate-200">{structural ? "结构说明" : "源码中的文档注释"}</h3>
          <pre className="whitespace-pre-wrap font-sans text-[1em] leading-[1.7] text-slate-400">{s.docstring}</pre>
        </section>
      )}

      <section className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4" aria-busy={loading}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[1em] font-semibold text-indigo-200">AI 讲解</h3>
          <div className="flex items-center gap-2">
            <label htmlFor="explain-backend" className="text-xs text-slate-300">讲解来源</label>
            <select id="explain-backend" value={backend} onChange={(event) => {
              const params = new URLSearchParams(searchParams.toString());
              params.set("ai", event.target.value);
              router.replace(`${pathname}?${params}`, { scroll: false });
            }} className="min-h-11 max-w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-200 focus-visible:outline-2 focus-visible:outline-indigo-400">
              <option value="api">模型 API{!ai.backends.api.available ? "（未配置）" : ""}</option>
              <option value="agent">本机 Agent · Codex{!ai.backends.agent.available ? "（未检测到）" : ""}</option>
            </select>
          </div>
        </div>
        <p className="mb-3 leading-[1.7] text-slate-400">
          {backend === "agent"
            ? "通过本机 Codex 生成讲解，使用已有 CLI 登录。本次只提供当前节点源码和静态分析事实。"
            : `通过模型 API 生成讲解${selected.model ? `（${selected.model}）` : ""}，密钥仅在服务端读取。`}
        </p>
        {cached ? (
          <>
            <Markdown text={cached.explanation} />
            {cached.relativeLines && <p className="mt-2 text-xs text-slate-500">讲解中的“{structural ? "片段" : "方法"}内行号”以当前{structural ? "节点" : "方法"}的第一行为第 1 行。</p>}
            <p className="mt-3 text-xs text-slate-500">
              由 {cached.model ?? "模型"} 生成{cached.generatedAt ? ` · ${new Date(cached.generatedAt).toLocaleString("zh-CN")}` : ""} · AI 内容可能有误，请对照源码阅读
            </p>
          </>
        ) : <p className="leading-[1.7] text-slate-400">此来源尚未生成讲解，生成后会单独缓存。</p>}
        {!selected.available && <p className="mt-3 leading-[1.7] text-amber-200">
          {backend === "agent" ? "未检测到 Codex。请先安装并执行 codex login，再重启应用。" : "模型 API 未配置。请在服务端设置 AI_API_KEY 后重启，或切换到本机 Agent。"}
        </p>}
        {selected.available && <button onClick={() => generate(!!cached)} disabled={loading} className="atlas-primary mt-3 min-h-11 min-w-32 px-4 py-2 text-sm disabled:cursor-wait">
          {loading ? (backend === "agent" ? "Agent 正在分析…" : "正在生成…") : error ? "重试生成" : cached ? "重新生成" : "生成 AI 讲解"}
        </button>}
        {loading && <button onClick={stop} className="ml-2 mt-3 min-h-11 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">停止分析</button>}
        <div aria-live="polite">
          {loading && <p className="mt-2 text-xs leading-5 text-slate-400">{backend === "agent" && currentRequest && currentRequest.phase !== "cancelled" ? PHASE_LABEL[currentRequest.phase] : "正在等待模型返回讲解"} · 已用时 {elapsedSeconds} 秒{currentRequest?.timeoutMs ? ` · 最长等待 ${Math.ceil(currentRequest.timeoutMs / 1000)} 秒` : ""}</p>}
          {loading && <p className="mt-2 text-xs leading-5 text-slate-400">可继续切换方法、页签或讲解来源，生成会在后台继续；点击“停止分析”可取消。刷新或关闭页面会中断尚未完成的任务。</p>}
          {loading && backend === "agent" && elapsedSeconds >= 30 && <p className="mt-2 text-xs leading-5 text-amber-200">耗时较长，模型速度和网络会影响等待时间。可继续浏览，完成后会自动保存。</p>}
          {currentRequest?.phase === "cancelled" && <p className="mt-2 text-xs text-slate-400">已取消本次讲解，可随时重新生成。</p>}
          {!loading && currentRequest?.durationMs !== undefined && <p className="mt-2 text-xs text-slate-500">本次生成耗时 {(currentRequest.durationMs / 1000).toFixed(1)} 秒</p>}
          {error && <p role="alert" className="mt-3 rounded bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
        </div>
      </section>

      {(s.kind === "class" || structural) && detail.children.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-semibold text-slate-200">{structural ? "子节点" : "成员"}（{detail.children.length}）</h3>
          <ul className="space-y-0.5">
            {(structural ? detail.children.slice(0, childrenLimit) : detail.children).map((c) => (
              <li key={c.id}>
                <button onClick={() => onNavigate(c.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-slate-300 hover:bg-slate-800">
                  <KindIcon kind={c.kind} />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto text-xs text-slate-500">L{c.startLine}</span>
                </button>
              </li>
            ))}
          </ul>
          {structural && childrenLimit < detail.children.length && <button onClick={() => setChildrenPage({ id: s.id, limit: childrenLimit + STRUCTURE_PAGE_SIZE })} className="mt-2 rounded px-2 py-1 text-xs text-indigo-300 hover:bg-slate-800">再显示 {Math.min(STRUCTURE_PAGE_SIZE, detail.children.length - childrenLimit)} 项（剩余 {detail.children.length - childrenLimit} 项）</button>}
        </section>
      )}

      <section>
        <button onClick={() => setShowImports((v) => !v)} className="flex w-full items-center justify-between text-left text-sm font-semibold text-slate-200">
          <span>
            本文件的导入（{file.imports.length}
            {unresolvedImports.length ? `，其中 ${unresolvedImports.length} 项无法解析` : ""}）
          </span>
          <span className="text-xs text-slate-500">{showImports ? "收起" : "展开"}</span>
        </button>
        {showImports && (
          <ul className="mt-2 space-y-1.5">
            {file.imports.length === 0 && <li className="text-xs text-slate-500">无导入</li>}
            {file.imports.map((i, idx) => (
              <li key={idx} className="rounded-lg bg-slate-900/60 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-slate-300">{i.specifier}</span>
                  <span className="text-slate-500">L{i.line}</span>
                  {i.kind === "project" && <Chip tone={i.guess ? "indigo" : "emerald"}>{i.guess ? "项目内·推断" : "项目内"}</Chip>}
                  {i.kind === "external" && <Chip>外部/标准库</Chip>}
                  {i.kind === "unresolved" && <Chip tone="rose">无法解析</Chip>}
                </div>
                <div className="mt-1 break-all text-slate-500">
                  {i.names.join(", ")}
                  {i.resolvedPath ? ` → ${i.resolvedPath}` : ""}
                </div>
                {i.reason && <div className="mt-1 text-rose-300/80">{i.reason}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>}
    </ReadingZoom>
  );
}
