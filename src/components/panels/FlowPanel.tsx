"use client";

import { useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import type { AnalysisResult } from "@/lib/api-types";
import type { FlowGraph, FlowNode } from "@/lib/analysis/types";
import type { ViewerHighlight } from "../viewer-types";

interface Props {
  state: { loading: boolean; error: string | null; data: AnalysisResult | null };
  onHighlight: (h: ViewerHighlight | null) => void;
}

type NodeData = { node: FlowNode; w: number; h: number; selected: boolean } & Record<string, unknown>;

const KIND_STYLE: Record<string, string> = {
  start: "bg-indigo-500/20 border-indigo-400 text-indigo-100 rounded-full",
  end: "bg-slate-700/60 border-slate-400 text-slate-100 rounded-full",
  process: "bg-slate-800 border-slate-600 text-slate-100 rounded-md",
  decision: "bg-amber-500/15 border-amber-400 text-amber-100",
  loop: "bg-sky-500/15 border-sky-400 text-sky-100 rounded-xl",
  return: "bg-emerald-500/15 border-emerald-400 text-emerald-100 rounded-lg",
  throw: "bg-rose-500/15 border-rose-400 text-rose-100 rounded-lg",
  try: "bg-violet-500/15 border-violet-400 text-violet-100 rounded-md",
  handler: "bg-rose-500/10 border-rose-400/70 text-rose-100 rounded-md",
  switch: "bg-amber-500/15 border-amber-400 text-amber-100",
  case: "bg-slate-800 border-amber-400/60 text-slate-100 rounded-md",
};

const HEX = "polygon(8% 0, 92% 0, 100% 50%, 92% 100%, 8% 100%, 0 50%)";

function measure(n: FlowNode): { w: number; h: number; lines: string[] } {
  const raw = n.label.split("\n");
  const lines = raw.length > 5 ? [...raw.slice(0, 4), `… 另 ${raw.length - 4} 行`] : raw;
  const longest = Math.max(...lines.map((l) => l.length), 4);
  const hex = n.kind === "decision" || n.kind === "switch";
  const w = Math.min(320, Math.max(90, longest * 7.4 + (hex ? 56 : 28)));
  const h = lines.length * 18 + 16 + (n.calls.length ? 22 : 0) + (hex ? 14 : 0);
  return { w, h, lines };
}

function FlowNodeView({ data }: NodeProps<Node<NodeData>>) {
  const { node, w, h, selected } = data;
  const { lines } = measure(node);
  const hex = node.kind === "decision" || node.kind === "switch";
  return (
    <div
      style={{ width: w, minHeight: h, clipPath: hex ? HEX : undefined }}
      className={`flex flex-col items-center justify-center border px-3 py-2 text-center font-mono text-[11.5px] leading-[18px] ${KIND_STYLE[node.kind] ?? KIND_STYLE.process} ${selected ? "ring-2 ring-yellow-300" : ""}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {lines.map((l, i) => (
        <div key={i} className="max-w-full whitespace-pre-wrap break-words">
          {l}
        </div>
      ))}
      {node.calls.length > 0 && (
        <div className="mt-1 flex max-w-full flex-wrap justify-center gap-1">
          {node.calls.slice(0, 3).map((c) => (
            <span key={c} className="max-w-[140px] truncate rounded bg-black/30 px-1 text-[10px] text-emerald-300" title={`调用 ${c}`}>
              ƒ {c}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { flow: FlowNodeView };

function layout(graph: FlowGraph, selectedId: string | null): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 52, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of graph.nodes) {
    const m = measure(n);
    sizes.set(n.id, { w: m.w, h: m.h });
    g.setNode(n.id, { width: m.w, height: m.h });
  }
  for (const e of graph.edges) g.setEdge(e.source, e.target, { width: e.label ? 28 : 0, height: e.label ? 16 : 0, labelpos: "c" });
  dagre.layout(g);
  const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
    const p = g.node(n.id);
    const s = sizes.get(n.id)!;
    return {
      id: n.id,
      type: "flow",
      position: { x: p.x - s.w / 2, y: p.y - s.h / 2 },
      data: { node: n, w: s.w, h: s.h, selected: n.id === selectedId },
      draggable: false,
    };
  });
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: e.kind === "exception" ? "#fb7185" : e.kind === "back" ? "#a78bfa" : "#94a3b8" },
    style: {
      stroke: e.kind === "exception" ? "#fb7185" : e.kind === "back" ? "#a78bfa" : "#94a3b8",
      strokeDasharray: e.kind === "normal" ? undefined : "5 4",
      strokeWidth: 1.4,
    },
    labelStyle: { fill: "#e2e8f0", fontSize: 11 },
    labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
  }));
  return { nodes, edges };
}

export default function FlowPanel({ state, onHighlight }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const flow = state.data?.flow ?? null;
  const laid = useMemo(() => (flow ? layout(flow, selected) : null), [flow, selected]);

  if (state.loading) return <div className="p-8 text-center text-sm text-slate-500">正在生成流程图…</div>;
  if (state.error) return <div className="p-4 text-sm text-rose-300">{state.error}</div>;
  if (!state.data) return null;
  if (!flow || !laid) {
    return <div className="p-6 text-center text-sm leading-6 text-slate-500">{state.data.notes.join(" ") || "该符号没有流程图"}</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-2 text-[11px] text-slate-400">
        <span>点击节点可在源码中定位</span>
        <span className="text-slate-600">|</span>
        <span>
          <i className="mr-1 inline-block h-2 w-3 border border-amber-400 bg-amber-500/20" />
          判断
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-3 rounded-sm border border-sky-400 bg-sky-500/20" />
          循环
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-3 rounded-sm border border-emerald-400 bg-emerald-500/20" />
          return
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-3 rounded-sm border border-rose-400 bg-rose-500/20" />
          异常
        </span>
        <span className="text-violet-300">┄ 回边</span>
        {flow.truncated && <span className="text-amber-300">⚠ 流程过长，已截断</span>}
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={laid.nodes}
          edges={laid.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
          minZoom={0.1}
          maxZoom={2}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
          onNodeClick={(_, n) => {
            const fn = (n.data as NodeData).node;
            setSelected(fn.id);
            onHighlight({ startLine: fn.startLine, endLine: fn.endLine });
          }}
          onPaneClick={() => {
            setSelected(null);
            onHighlight(null);
          }}
        >
          <Background color="#1e293b" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <ul className="max-h-24 space-y-0.5 overflow-y-auto border-t border-slate-800 px-4 py-2 text-[11px] leading-4 text-slate-500">
        {state.data.notes.map((n, i) => (
          <li key={i}>※ {n}</li>
        ))}
      </ul>
    </div>
  );
}
