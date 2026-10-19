"use client";

import { useTheme } from "./ThemeToggle";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { CallTreeDirection, CallTreePage, CallTreeSymbol } from "@/lib/api-types";
import { buildCallTree, type CallTreeLoad, type CallTreeOccurrence } from "@/lib/analysis/call-tree";
import { ConfidenceBadge } from "./Badges";

interface Props {
  projectId: number;
  root: CallTreeSymbol;
  selectedId: number;
  direction: CallTreeDirection;
  active: boolean;
  onDirection: (direction: CallTreeDirection) => void;
  onSelect: (id: number) => void;
  onInspect: (ownerId: number, refId: number) => void;
  onViewSource: (id: number) => void;
  onRestart: (id: number) => void;
  onProjectOverview: () => void;
}

type CardData = Record<string, unknown> & {
  item: CallTreeOccurrence;
  selected: boolean;
  onToggle: (item: CallTreeOccurrence) => void;
  onPick: (item: CallTreeOccurrence) => void;
  onSource: (id: number) => void;
  onMeasure: (id: string, height: number) => void;
};
type CallNode = Node<CardData>;
const WIDTH = 280;
const HEIGHT = 142;
const COLORS = { exact: "var(--atlas-ref-exact)", inferred: "var(--atlas-ref-inferred)", heuristic: "var(--atlas-ref-heuristic)", external: "var(--atlas-ref-external)", unresolved: "var(--atlas-ref-unresolved)" };

function CallCard({ data }: NodeProps<CallNode>) {
  const { item, selected, onToggle, onPick, onSource, onMeasure } = data;
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    // offsetHeight includes the border and is independent of the canvas zoom.
    const measure = () => onMeasure(item.id, element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.id, onMeasure]);
  const actionable = item.type !== "status" || !!item.error;
  return (
    <div ref={card} style={{ width: WIDTH }} className={`flex min-h-[142px] flex-col rounded-lg border bg-slate-900 px-3 py-2.5 shadow-lg ${selected ? "border-indigo-400 ring-1 ring-indigo-400/60" : item.type === "candidates" ? "border-dashed border-amber-500/60" : "border-slate-700"}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="!bg-slate-500" />
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-[10px] text-slate-500">{item.id === "root" ? "探索起点" : item.type === "candidates" ? "候选分支" : item.type === "symbol" ? "项目内方法" : item.type === "terminal" ? "调用边界" : ""}</span>
        {item.resolution && <ConfidenceBadge level={item.resolution} />}
        {item.cycle && <span className="text-[10px] text-amber-300">循环调用</span>}
      </div>
      <div className="mt-1 flex shrink-0 items-start gap-1">
        <button disabled={!actionable || item.loading && item.type === "more"} onClick={() => onPick(item)} title={item.label} className="nodrag nopan min-w-0 flex-1 whitespace-normal text-left text-sm font-semibold text-slate-100 [overflow-wrap:anywhere] hover:text-indigo-200 disabled:cursor-default disabled:text-slate-400">
          {item.loading && item.type === "more" ? "正在加载…" : item.label}
        </button>
        {item.expandable && <button onClick={() => onToggle(item)} aria-label={`${item.expanded ? "收起" : "展开"} ${item.label}`} aria-expanded={item.expanded} className="nodrag nopan shrink-0 rounded bg-slate-800 px-2 py-0.5 text-sm text-indigo-200 hover:bg-indigo-500/30">{item.expanded ? "−" : "+"}</button>}
      </div>
      <div title={item.subtitle} className="mt-1 shrink-0 text-[11px] leading-4 text-slate-400 [overflow-wrap:anywhere]">{item.subtitle}</div>
      <div title={item.reason ?? item.error} className="mt-1 min-h-8 shrink-0 text-[10px] leading-4 text-slate-500 [overflow-wrap:anywhere]">{item.reason ?? item.error ?? (item.type === "symbol" ? "点击名称查看详情，+ 展开下一层" : item.type === "terminal" ? "点击查看此处引用" : item.type === "candidates" ? "展开后分别查看候选，尚未确定实际目标" : "")}</div>
      {item.symbol && <button onClick={() => onSource(item.symbol!.id)} className="nodrag nopan mt-2 shrink-0 self-start text-[10px] text-indigo-300 hover:text-slate-100">查看源码 ↗</button>}
      <Handle type="source" position={Position.Right} isConnectable={false} className="!bg-slate-500" />
    </div>
  );
}
const nodeTypes = { call: CallCard };

export default function CallTreeExplorer({ projectId, root, selectedId, direction, active, onDirection, onSelect, onInspect, onViewSource, onRestart, onProjectOverview }: Props) {
  const [showTerminals, setShowTerminals] = useState(false);
  return <Explorer key={String(showTerminals)} projectId={projectId} root={root} selectedId={selectedId} direction={direction} active={active}
    onDirection={onDirection} onSelect={onSelect} onInspect={onInspect} onViewSource={onViewSource} onRestart={onRestart} onProjectOverview={onProjectOverview}
    showTerminals={showTerminals} onBoundaries={setShowTerminals} />;
}

function Explorer({ projectId, root, selectedId, direction, active, onDirection, onSelect, onInspect, onViewSource, onRestart, onProjectOverview, showTerminals, onBoundaries }: Props & { showTerminals: boolean; onBoundaries: (value: boolean) => void }) {
  const theme = useTheme();
  const [pages, setPages] = useState<Map<number, CallTreeLoad>>(() => new Map());
  const cache = useRef(new Map<number, CallTreeLoad>());
  const requests = useRef(new Map<number, AbortController>());
  const [expanded, setExpanded] = useState(() => new Set(["root"]));
  const [heights, setHeights] = useState(() => new Map<string, number>());
  const measureCard = useCallback((id: string, height: number) => {
    if (height <= 0) return; // Hidden source/explore panels must retain their last dimensions.
    setHeights((previous) => previous.get(id) === height ? previous : new Map(previous).set(id, height));
  }, []);
  const [instance, setInstance] = useState<ReactFlowInstance<CallNode, Edge> | null>(null);
  const fitted = useRef(false);

  const load = useCallback(async (id: number, more = false) => {
    if (requests.current.has(id)) return;
    const previous = cache.current.get(id);
    if (!more && previous?.page) return;
    const offset = more ? previous?.page?.nextOffset : 0;
    if (offset == null) return;
    const ac = new AbortController();
    requests.current.set(id, ac);
    const publish = (value: CallTreeLoad) => {
      if (ac.signal.aborted) return;
      cache.current.set(id, value);
      setPages(new Map(cache.current));
    };
    publish({ ...previous, loading: true, error: undefined });
    try {
      const response = await fetch(`/api/projects/${projectId}/symbols/${id}/calls?direction=${direction}&offset=${offset}&scope=${showTerminals ? "all" : "project"}`, { signal: ac.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `加载失败（HTTP ${response.status}）`);
      const page = body as CallTreePage;
      publish({ page: more && previous?.page ? { ...page, branches: [...previous.page.branches, ...page.branches] } : page });
    } catch (error) {
      if (!ac.signal.aborted) publish({ ...previous, loading: false, error: error instanceof Error ? error.message : "加载失败，请重试" });
    } finally {
      if (requests.current.get(id) === ac) requests.current.delete(id);
    }
  }, [projectId, direction, showTerminals]);

  useEffect(() => {
    const pending = requests.current;
    let alive = true;
    void Promise.resolve().then(() => { if (alive) void load(root.id); });
    return () => { alive = false; pending.forEach((ac) => ac.abort()); pending.clear(); };
  }, [load, root.id]);

  const toggle = useCallback((item: CallTreeOccurrence) => {
    setExpanded((previous) => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; });
    if (!item.expanded && item.symbol) void load(item.symbol.id);
  }, [load]);
  const pick = useCallback((item: CallTreeOccurrence) => {
    if (item.symbol) onSelect(item.symbol.id);
    else if (item.type === "candidates") toggle(item);
    else if (item.ownerId && (item.type === "more" || item.type === "status" && item.error)) void load(item.ownerId, item.type === "more");
    else if (item.ownerId && item.refId) onInspect(item.ownerId, item.refId);
  }, [onSelect, onInspect, toggle, load]);

  const tree = useMemo(() => buildCallTree(root, pages, expanded, showTerminals), [root, pages, expanded, showTerminals]);
  const graph = useMemo(() => {
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({ rankdir: "LR", ranksep: 70, nodesep: 22 });
    layout.setDefaultEdgeLabel(() => ({}));
    tree.nodes.forEach((node) => layout.setNode(node.id, { width: WIDTH, height: heights.get(node.id) ?? HEIGHT }));
    tree.edges.forEach((edge) => layout.setEdge(edge.source, edge.target));
    dagre.layout(layout);
    const origin = layout.node("root");
    const nodes: CallNode[] = tree.nodes.map((item) => {
      const point = layout.node(item.id);
      const height = heights.get(item.id) ?? HEIGHT;
      const rootHeight = heights.get("root") ?? HEIGHT;
      return { id: item.id, type: "call", position: { x: point.x - origin.x, y: point.y - origin.y - (height - rootHeight) / 2 }, draggable: false,
        data: { item, selected: item.symbol?.id === selectedId, onToggle: toggle, onPick: pick, onSource: onViewSource, onMeasure: measureCard } };
    });
    const edges: Edge[] = tree.edges.map((edge) => {
      const color = edge.resolution ? COLORS[edge.resolution] : "var(--atlas-flow-edge)";
      return { ...edge, type: "smoothstep", markerEnd: direction === "outgoing" ? { type: MarkerType.ArrowClosed, color } : undefined,
        markerStart: direction === "incoming" ? { type: MarkerType.ArrowClosed, color } : undefined,
        style: { stroke: color, strokeWidth: 1.5, strokeDasharray: edge.resolution === "heuristic" ? "5 4" : undefined } };
    });
    return { nodes, edges };
  }, [tree, selectedId, toggle, pick, onViewSource, direction, heights, measureCard]);

  const rootLoaded = !!pages.get(root.id)?.page;
  useEffect(() => {
    if (!active || !instance || !rootLoaded || fitted.current) return;
    const frame = requestAnimationFrame(() => {
      const children = instance.getNodes().filter((node) => node.id !== "root");
      const nearest = children.sort((a, b) => Math.abs(a.position.y) - Math.abs(b.position.y))[0];
      void instance.fitView({ nodes: [{ id: "root" }, ...(nearest ? [{ id: nearest.id }] : [])], padding: 0.2, minZoom: 0.6, maxZoom: 1 });
      fitted.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, instance, rootLoaded]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/70 px-3 py-2 text-xs">
        <button onClick={onProjectOverview} className="rounded px-2 py-1 text-indigo-300 hover:bg-slate-800">← 项目总览</button>
        <span title={root.name} className="max-w-44 truncate text-slate-200">起点：{root.name}</span>
        <select aria-label="探索方向" value={direction} onChange={(event) => onDirection(event.target.value as CallTreeDirection)} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200">
          <option value="outgoing">它调用谁 →</option><option value="incoming">谁调用它 ←</option>
        </select>
        <button onClick={() => onRestart(selectedId)} disabled={selectedId === root.id} className="rounded border border-slate-700 px-2 py-1 text-indigo-200 hover:bg-slate-800 disabled:opacity-40">以当前方法为起点</button>
        <button onClick={() => onViewSource(selectedId)} className="rounded px-2 py-1 text-slate-300 hover:bg-slate-800">查看当前源码</button>
        <button onClick={() => setExpanded(new Set())} className="ml-auto rounded px-2 py-1 text-slate-400 hover:bg-slate-800">全部收起</button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-800 px-3 py-1.5 text-[11px] text-slate-500">
        <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={showTerminals} onChange={(event) => onBoundaries(event.target.checked)} />显示外部 / 未解析调用</label>
        <span>{tree.nodes.length} 个节点 · 点击 + 逐层展开 · 拖动画布 / 滚轮缩放</span>
      </div>
      {tree.truncated && <p role="status" className="bg-amber-500/10 px-3 py-2 text-xs text-amber-200">已显示 180 个节点。收起部分分支，或选中方法并设为新起点继续探索。</p>}
      <div className="min-h-0 flex-1" aria-label="方法调用探索树">
        <ReactFlow<CallNode> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onInit={setInstance} nodesDraggable={false} nodesConnectable={false} minZoom={0.15} maxZoom={1.5} fitView fitViewOptions={{ maxZoom: 1 }} colorMode={theme}>
          <Background color="var(--atlas-border)" gap={22} /><Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="shrink-0 border-t border-slate-800 px-3 py-1.5 text-[11px] text-slate-500">连线表示静态调用关系，不代表执行顺序。绿色确定 · 蓝色推断 · 黄色虚线候选；循环路径停止展开。</div>
    </div>
  );
}
