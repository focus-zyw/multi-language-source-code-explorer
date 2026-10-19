"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult, CallTreeDirection, CallTreeSymbol, ProjectInfo, SymbolDetail, TreeData } from "@/lib/api-types";
import { RESOLUTION_LABELS, type ResolutionT } from "@/lib/shared";
import { CodeViewer } from "./CodeViewer";
import { ThemeToggle } from "./ThemeToggle";
import { ConfidenceBadge, Chip, KindIcon, kindLabel } from "./Badges";
import { ImportReport } from "./ImportReport";
import { RescanButton } from "./RescanButton";
import { ResizablePanels } from "./ResizablePanels";
import { SymbolTree } from "./SymbolTree";
import { ProjectOverview } from "./ProjectOverview";
import { ExplainPanel } from "./panels/ExplainPanel";
import { QuestionsPanel } from "./panels/QuestionsPanel";
import type { QuestionQuote } from "@/lib/question-types";
import { ReadingShortcutHint } from "./ReadingZoom";
import { LANGUAGE_SHORT_LABELS } from "@/lib/languages";
import { RefsPanel } from "./panels/RefsPanel";
import { TestsPanel } from "./panels/TestsPanel";
import { VarsPanel } from "./panels/VarsPanel";
import type { ViewerHighlight, ViewerRef } from "./viewer-types";
import type { AiPublicStatus, ExplanationBackend, ExplanationResult } from "@/lib/ai-types";

const FlowPanel = dynamic(() => import("./panels/FlowPanel"), {
  ssr: false,
  loading: () => <div className="p-8 text-center text-sm text-slate-500">正在加载流程图组件…</div>,
});

const CallTreeExplorer = dynamic(() => import("./CallTreeExplorer"), {
  ssr: false,
  loading: () => <div className="p-8 text-center text-sm text-slate-500">正在加载流程探索…</div>,
});

type Tab = "explain" | "questions" | "refs" | "tests" | "flow" | "vars";
type Scoped<T> = T & { forId: number | null };
interface AnalysisState {
  id: number | null;
  loading: boolean;
  error: string | null;
  data: AnalysisResult | null;
}

export function Workspace({ project, tree, ai }: { project: ProjectInfo; tree: TreeData; ai: AiPublicStatus }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const sParam = sp.get("s");
  const selectedId = sParam && /^\d{1,9}$/.test(sParam) ? Number(sParam) : null;
  const exploring = sp.get("view") === "explore";
  const rootParam = sp.get("root");
  const rootId = rootParam && /^\d{1,9}$/.test(rootParam) ? Number(rootParam) : null;
  const projectOverview = exploring && (!rootParam || rootParam === "project");
  const direction: CallTreeDirection = sp.get("direction") === "incoming" ? "incoming" : "outgoing";

  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const cache = useRef(new Map<number, SymbolDetail>());

  const [tab, setTab] = useState<Tab>("explain");
  const [codeQuote, setCodeQuote] = useState<{ forId: number; quote: QuestionQuote } | null>(null);
  const [questionQuote, setQuestionQuote] = useState<{ forId: number; quote: QuestionQuote | null } | null>(null);
  const [mode, setMode] = useState<"method" | "file">("method");
  const [showSidebar, setShowSidebar] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [highlight, setHighlight] = useState<Scoped<ViewerHighlight> | null>(null);
  const [focusRef, setFocusRef] = useState<{ id: number; forId: number | null } | null>(null);
  const [navNote, setNavNote] = useState<Scoped<{ text: string; level: ResolutionT }> | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState>({ id: null, loading: false, error: null, data: null });
  const analysisCache = useRef(new Map<number, AnalysisResult>());

  // 加载符号详情
  useEffect(() => {
    if (selectedId === null || projectOverview) return;
    const cached = cache.current.get(selectedId);
    if (cached) {
      setDetail(cached);
      setLoadErr(null);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setLoadErr(null);
    fetch(`/api/projects/${project.id}/symbols/${selectedId}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `加载失败（HTTP ${r.status}）`);
        return (await r.json()) as SymbolDetail;
      })
      .then((d) => {
        cache.current.set(selectedId, d);
        setDetail(d);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") setLoadErr(e.message);
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [selectedId, project.id, projectOverview]);

  // 流程图 / 变量：切到对应页签时按需分析
  useEffect(() => {
    if (selectedId === null || projectOverview || (tab !== "flow" && tab !== "vars")) return;
    const cached = analysisCache.current.get(selectedId);
    if (cached) {
      setAnalysis({ id: selectedId, loading: false, error: null, data: cached });
      return;
    }
    const ac = new AbortController();
    setAnalysis({ id: selectedId, loading: true, error: null, data: null });
    fetch(`/api/projects/${project.id}/symbols/${selectedId}/analysis`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `分析失败（HTTP ${r.status}）`);
        return (await r.json()) as AnalysisResult;
      })
      .then((d) => {
        analysisCache.current.set(selectedId, d);
        setAnalysis({ id: selectedId, loading: false, error: null, data: d });
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") setAnalysis({ id: selectedId, loading: false, error: e.message, data: null });
      });
    return () => ac.abort();
  }, [tab, selectedId, project.id, projectOverview]);

  const current = detail && detail.symbol.id === selectedId ? detail : null;
  const shown = current ?? detail;
  const analysisView = analysis.id === selectedId ? analysis : { loading: true, error: null, data: null };

  const navigate = useCallback(
    (id: number, note?: { text: string; level: ResolutionT }) => {
      setNavNote(note ? { ...note, forId: id } : null);
      const params = new URLSearchParams(sp.toString());
      params.set("s", String(id));
      if (exploring && rootId !== null) params.set("root", String(rootId));
      router.push(`${pathname}?${params}`, { scroll: false });
    },
    [router, pathname, sp, exploring, rootId],
  );

  const changeView = useCallback((view: "source" | "explore", id = selectedId, restart = false, nextDirection = direction) => {
    const params = new URLSearchParams(sp.toString());
    if (id !== null) params.set("s", String(id));
    if (view === "explore") {
      params.set("view", "explore");
      params.set("root", restart && id !== null ? String(id) : rootParam ?? "project");
      params.set("direction", nextDirection);
    } else params.delete("view");
    setNavNote(null);
    router.push(`${pathname}?${params}`, { scroll: false });
  }, [selectedId, direction, sp, rootParam, router, pathname]);

  const openProjectOverview = useCallback(() => {
    const params = new URLSearchParams(sp.toString());
    params.set("view", "explore");
    params.set("root", "project");
    params.delete("direction");
    router.push(`${pathname}?${params}`, { scroll: false });
  }, [sp, router, pathname]);

  const selectFromTree = useCallback((id: number) => {
    if (["element", "property"].includes(tree.symbols.find((s) => s.id === id)?.kind ?? "")) changeView("source", id);
    else if (exploring) changeView("explore", id, true);
    else navigate(id);
  }, [exploring, changeView, navigate, tree.symbols]);

  const inspectCall = useCallback((ownerId: number, refId: number) => {
    navigate(ownerId);
    setTab("refs");
    setFocusRef({ id: refId, forId: ownerId });
  }, [navigate]);
  const viewSource = useCallback((id: number) => changeView("source", id), [changeView]);
  const restartTree = useCallback((id: number) => changeView("explore", id, true), [changeView]);
  const changeDirection = useCallback((next: CallTreeDirection) => changeView("explore", selectedId, false, next), [changeView, selectedId]);

  const onHighlight = useCallback((h: ViewerHighlight | null) => setHighlight(h ? { ...h, forId: selectedId } : null), [selectedId]);

  const viewerRefs: ViewerRef[] = useMemo(
    () =>
      (current?.outgoing ?? []).map((o) => ({
        id: o.id,
        line: o.line,
        col: o.col,
        endLine: o.endLine,
        endCol: o.endCol,
        resolution: o.resolution,
        label: o.targets.length ? `${o.calleeText} → ${o.targets.slice(0, 3).map((t) => t.name).join(" | ")}` : `${o.calleeText}：${o.reason}`,
      })),
    [current],
  );

  const onRefClick = useCallback(
    (refId: number) => {
      if (!current) return;
      const o = current.outgoing.find((x) => x.id === refId);
      if (!o) return;
      if ((o.resolution === "exact" || o.resolution === "inferred") && o.targets.length === 1) {
        navigate(o.targets[0].symbolId, { text: `${o.calleeText} → ${o.targets[0].name}：${o.reason}`, level: o.resolution });
        return;
      }
      setTab("refs");
      setFocusRef({ id: refId, forId: selectedId });
      setHighlight({ startLine: o.line, endLine: o.endLine, startCol: o.col, endCol: o.endCol, forId: selectedId });
    },
    [current, navigate, selectedId],
  );

  const onAiUpdate = useCallback((symbolId: number, backend: ExplanationBackend, aiData: ExplanationResult) => {
    const d = cache.current.get(symbolId);
    if (!d) return;
    const next: SymbolDetail = { ...d, ai: { ...d.ai, explanations: { ...d.ai.explanations, [backend]: aiData } } };
    cache.current.set(symbolId, next);
    setDetail((prev) => (prev && prev.symbol.id === symbolId ? next : prev));
  }, []);

  const quickPicks = useMemo(
    () => tree.symbols.filter((s) => !s.isTest && (s.kind === "function" || s.kind === "method") && s.parentId === null || (!s.isTest && s.kind === "method")).slice(0, 8),
    [tree.symbols],
  );
  const fileById = useMemo(() => new Map(tree.files.map((f) => [f.id, f])), [tree.files]);
  const explorationRoot: CallTreeSymbol | null = useMemo(() => {
    const symbol = tree.symbols.find((item) => item.id === rootId);
    return symbol ? { id: symbol.id, name: symbol.qualifiedName, kind: symbol.kind, filePath: fileById.get(symbol.fileId)?.path ?? "", line: symbol.startLine } : null;
  }, [rootId, tree.symbols, fileById]);

  const hl = highlight && highlight.forId === selectedId ? highlight : null;
  const note = navNote && navNote.forId === selectedId ? navNote : null;
  const focus = focusRef && focusRef.forId === selectedId ? focusRef.id : null;

  const structural = ["element", "property"].includes(shown?.symbol.kind ?? "");
  const activeTab = structural && tab !== "questions" ? "explain" : tab;
  const ask = (quote: QuestionQuote | null) => { if (shown) setQuestionQuote({ forId: shown.symbol.id, quote }); setTab("questions"); };
  const tabs: { key: Tab; label: string; count?: string }[] = [
    { key: "explain", label: "讲解" },
    { key: "questions", label: "问答" },
    ...(!structural ? [{ key: "refs" as const, label: "引用", count: shown ? `${shown.outgoing.length}·${shown.incoming.length}` : undefined },
    { key: "tests" as const, label: "关联测试", count: shown ? String(new Set(shown.tests.map((t) => t.otherSymbolId)).size) : undefined },
    { key: "flow" as const, label: "流程图" },
    { key: "vars" as const, label: "变量" }] : []),
  ];

  return (
    <div className="atlas-workspace flex h-dvh flex-col overflow-hidden bg-slate-950">
      <header className="atlas-toolbar flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2">
        <button onClick={() => setShowSidebar((v) => !v)} aria-label="显示/隐藏文件树" aria-expanded={showSidebar} className="rounded-md p-2 text-slate-400 hover:bg-slate-800" title="显示/隐藏文件树">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
        </button>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-100">
          ← 项目
        </Link>
        <span className="text-slate-700">/</span>
        <h1 className="min-w-0 max-w-52 truncate text-sm font-semibold text-slate-100" title={project.name}>{project.name}</h1>
        <div className="hidden gap-1.5 xl:flex">
          {Object.entries(project.languages).map(([l, n]) => (
            <Chip key={l}>
              {LANGUAGE_SHORT_LABELS[l] ?? l} {n}
            </Chip>
          ))}
          <Chip>{project.symbolCount} 符号</Chip>
        </div>
        <div className="atlas-segmented ml-auto shrink-0" role="group" aria-label="工作区模式">
          <button onClick={() => changeView("source")} aria-pressed={!exploring} className={`rounded px-3 py-1.5 ${!exploring ? "bg-indigo-500/30 text-indigo-100" : "text-slate-400 hover:text-slate-100"}`}>源码阅读</button>
          <button onClick={() => changeView("explore")} aria-pressed={exploring} className={`rounded px-3 py-1.5 ${exploring ? "bg-indigo-500/30 text-indigo-100" : "text-slate-400 hover:text-slate-100"}`}>流程探索</button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <span
            className={`hidden rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset sm:inline ${ai.configured ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/40" : "bg-slate-800 text-slate-400 ring-slate-700"}`}
            title="模型密钥只在服务端读取"
          >
            {ai.configured ? `AI · ${ai.model}` : "AI 未配置 · 静态摘要"}
          </span>
          {project.sourceType === "local" && project.sourcePath && <RescanButton projectId={project.id} sourcePath={project.sourcePath} inWorkspace />}
          <button onClick={() => setShowReport(true)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800">
            导入报告
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {showSidebar && (
          <aside aria-label="项目文件与符号" className={`atlas-sidebar ${exploring ? "w-52 xl:w-64" : "w-60 xl:w-72"} shrink-0 border-r border-slate-800`}>
            <SymbolTree tree={tree} selectedId={selectedId} onSelect={selectFromTree} />
          </aside>
        )}

        {projectOverview ? (
          <ProjectOverview key={project.id} projectId={project.id} projectName={project.name} onExplore={restartTree} />
        ) : selectedId === null ? (
          <main className="min-w-0 flex-1 overflow-y-auto p-8">
            <div className="mx-auto max-w-2xl">
              <h2 className="text-xl font-semibold text-slate-100">开始浏览 {project.name}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                在左侧文件树选择一个函数、方法或结构节点，或搜索名称。阅读源码时，带下划线的调用可以点击跳转；
                下划线样式表示解析可信度。
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(["exact", "inferred", "heuristic", "external", "unresolved"] as ResolutionT[]).map((l) => (
                  <span key={l} className="inline-flex items-center gap-2" title={RESOLUTION_LABELS[l].hint}>
                    <ConfidenceBadge level={l} />
                  </span>
                ))}
              </div>
              <h3 className="mt-8 text-sm font-semibold text-slate-200">从这里开始</h3>
              <ul className="mt-2 space-y-1">
                {quickPicks.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => selectFromTree(s.id)} className="flex w-full items-center gap-2 rounded-lg bg-slate-900/60 px-3 py-2 text-left hover:bg-slate-800">
                      <KindIcon kind={s.kind} />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{s.qualifiedName}</span>
                      <span className="truncate text-[11px] text-slate-500">{fileById.get(s.fileId)?.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {project.stats && (
                <p className="mt-6 text-xs leading-5 text-slate-500">
                  共解析 {project.stats.refs.exact + project.stats.refs.inferred + project.stats.refs.heuristic + project.stats.refs.external + project.stats.refs.unresolved} 处调用：
                  确定 {project.stats.refs.exact}、推断 {project.stats.refs.inferred}、候选猜测 {project.stats.refs.heuristic}、外部/内建 {project.stats.refs.external}、无法解析{" "}
                  {project.stats.refs.unresolved}。
                </p>
              )}
            </div>
          </main>
        ) : (
          <ResizablePanels>
            <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-slate-800">
              {explorationRoot && <div className={exploring ? "min-h-0 flex-1" : "hidden"}>
                <CallTreeExplorer key={`${project.id}:${rootId}:${direction}`} projectId={project.id} root={explorationRoot} selectedId={selectedId} direction={direction} active={exploring}
                  onDirection={changeDirection} onSelect={navigate} onInspect={inspectCall} onViewSource={viewSource} onRestart={restartTree} onProjectOverview={openProjectOverview} />
              </div>}
              {exploring && !explorationRoot && <div className="p-8 text-sm text-slate-400">探索起点已失效，请从左侧重新选择方法。<button onClick={() => restartTree(selectedId)} className="ml-2 text-indigo-300">使用当前方法</button></div>}
              <div className={exploring ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
              <div className="atlas-toolbar flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1">
                <button onClick={() => router.back()} className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100" title="返回上一个浏览位置">
                  ← 返回
                </button>
                {shown ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-400">
                    <KindIcon kind={shown.symbol.kind} />
                    <span className="min-w-0 truncate" title={shown.file.path}>
                      {shown.file.path}
                      <span className="text-slate-600"> › </span>
                      <span className="text-slate-200">{shown.symbol.qualifiedName}</span>
                      <span className="text-slate-600">
                        {" "}
                        L{shown.symbol.startLine}–{shown.symbol.endLine}
                      </span>
                    </span>
                    {shown.symbol.isTest && <Chip tone="emerald">{kindLabel("test")}</Chip>}
                    {shown.file.hasSyntaxErrors && <Chip tone="amber">文件含语法错误</Chip>}
                  </div>
                ) : (
                  <span className="flex-1 text-xs text-slate-500">{loading ? "加载中…" : ""}</span>
                )}
                <div className="atlas-segmented shrink-0" role="group" aria-label="源码范围">
                  <button onMouseDown={(event) => event.preventDefault()} onClick={() => ask(codeQuote && codeQuote.forId === shown?.symbol.id ? codeQuote.quote : null)} disabled={!current} title="选中代码后引用提问；未选中则提问当前方法" className="rounded px-2 py-1 text-indigo-300 hover:bg-slate-800 disabled:opacity-50">问 AI</button>
                  <button onClick={() => setMode("method")} aria-pressed={mode === "method"}>
                    {structural ? "当前节点" : "仅方法"}
                  </button>
                  <button onClick={() => setMode("file")} aria-pressed={mode === "file"}>
                    整个文件
                  </button>
                </div>
              </div>

              {note && (
                <div className="flex shrink-0 items-start gap-2 border-b border-slate-800 bg-indigo-500/10 px-3 py-1.5 text-xs text-slate-300">
                  <ConfidenceBadge level={note.level} />
                  <span className="min-w-0 flex-1 leading-5">已跳转：{note.text}</span>
                  <button onClick={() => setNavNote(null)} className="text-slate-500 hover:text-slate-200">
                    ✕
                  </button>
                </div>
              )}
              {loadErr && <div className="shrink-0 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{loadErr}</div>}

              <div className={`relative min-h-0 flex-1 ${loading && !current ? "opacity-60" : ""}`}>
                {shown ? (
                  <CodeViewer
                    content={shown.file.content}
                    language={shown.file.language}
                    fileKey={`${shown.file.id}:${shown.symbol.id}`}
                    range={{ startLine: shown.symbol.startLine, endLine: shown.symbol.endLine }}
                    mode={mode}
                    refs={viewerRefs}
                    highlight={hl}
                    onRefClick={onRefClick}
                    onSelection={(selection) => setCodeQuote(selection ? { forId: shown.symbol.id, quote: { kind: "code", ...selection } } : null)}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-500">{loading ? "正在加载…" : (loadErr ?? "")}</div>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-800 bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-400">
                {structural ? <span>结构节点表示文档包含关系；可在左侧展开，或点击讲解中的子节点继续浏览。</span> : <>
                <span>点击带下划线的调用跳转：</span>
                <span className="border-b-2 border-emerald-400">确定</span>
                <span className="border-b-2 border-sky-400">推断</span>
                <span className="border-b-2 border-dashed border-amber-400">猜测（多候选）</span>
                <span className="border-b-2 border-dotted border-slate-500">外部</span>
                <span className="underline decoration-rose-400 decoration-wavy">无法解析</span>
                </>}
              </div>
              </div>
            </section>

            <section aria-label="源码详情" className="flex min-h-0 min-w-0 flex-col bg-slate-950/40">
              <div className="atlas-toolbar flex min-h-12 shrink-0 items-center border-b border-slate-800">
                <div className="atlas-tabs flex min-w-0 flex-1 overflow-x-auto" role="group" aria-label="详情面板">
                  {tabs.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setTab(t.key)}
                      aria-pressed={activeTab === t.key}
                      className={`shrink-0 border-b-2 px-3 py-2.5 text-[13px] ${activeTab === t.key ? "border-indigo-400 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}
                    >
                      {t.label}
                      {t.count !== undefined && <span className="ml-1 text-[11px] text-slate-500">{t.count}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className={`min-h-0 flex-1 ${activeTab === "flow" || activeTab === "questions" ? "overflow-hidden" : "overflow-y-auto"} ${loading && !current ? "opacity-60" : ""}`}>
                {!shown ? (
                  <div className="p-8 text-center text-sm text-slate-500">{loading ? "正在加载…" : (loadErr ?? "")}</div>
                ) : activeTab === "questions" ? (
                  <QuestionsPanel key={`${project.id}:${shown.symbol.id}`} projectId={project.id} detail={shown} quote={questionQuote?.forId === shown.symbol.id ? questionQuote.quote : null} onClearQuote={() => setQuestionQuote(null)} onSource={(id, startLine, endLine) => { changeView("source", id); setMode("file"); setHighlight({ forId: id, startLine, endLine }); }} />
                ) : activeTab === "explain" ? (
                  <ExplainPanel projectId={project.id} detail={shown} onNavigate={(id) => navigate(id)} onAiUpdate={onAiUpdate} onAsk={ask} />
                ) : tab === "refs" ? (
                  <RefsPanel detail={shown} focusRefId={focus} onNavigate={navigate} onHighlight={onHighlight} />
                ) : tab === "tests" ? (
                  <TestsPanel detail={shown} onNavigate={navigate} />
                ) : tab === "flow" ? (
                  <FlowPanel key={shown.symbol.id} state={analysisView} onHighlight={onHighlight} />
                ) : (
                  <VarsPanel state={analysisView} onHighlight={onHighlight} />
                )}
              </div>
            </section>
          </ResizablePanels>
        )}
      </div>
      <ReadingShortcutHint />
      {showReport && <ImportReport project={project} onClose={() => setShowReport(false)} />}
    </div>
  );
}
