"use client";

import { useMemo, useState } from "react";
import { Background, Controls, MarkerType, Position, ReactFlow, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import type { DependencyData } from "@/lib/project-insights";
import { useTheme } from "./ThemeToggle";

export default function DependencyExplorer({ data, onRead }: { data: DependencyData; onRead: (id: number) => void }) {
  const theme = useTheme();
  const [level, setLevel] = useState("file");
  const [selection, setSelection] = useState("");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("both");
  const [includeInferred, setIncludeInferred] = useState(false);
  const { model, options, selected, related, graph } = useMemo(() => {
    const groupOf = (path: string, id: number) => level === "file" ? String(id) : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    const groups = new Map<string, { id: string; label: string; files: typeof data.files }>();
    const fileGroup = new Map<number, string>();
    for (const file of data.files) {
      const id = groupOf(file.path, file.id), group = groups.get(id) ?? { id, label: level === "file" ? file.path : id, files: [] };
      group.files.push(file); groups.set(id, group); fileGroup.set(file.id, id);
    }
    const links = new Map<string, { source: string; target: string; inferred: boolean; count: number }>();
    for (const edge of data.edges) {
      if (edge.inferred && !includeInferred) continue;
      const source = fileGroup.get(edge.source)!, target = fileGroup.get(edge.target)!;
      if (source === target && level !== "file") continue;
      const key = JSON.stringify([source, target, edge.inferred]), link = links.get(key) ?? { source, target, inferred: edge.inferred, count: 0 };
      link.count += edge.count; links.set(key, link);
    }
    const model = { groups, links: [...links.values()], fileGroup };
  const options = [...model.groups.values()].filter((group) => group.label.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.label.localeCompare(b.label));
  const selected = model.groups.get(selection) ?? options[0];
  const selectedId = selected?.id;
  const related = model.links.filter((link) => selectedId !== undefined && ((direction !== "incoming" && link.source === selectedId) || (direction !== "outgoing" && link.target === selectedId)));
  const graph = (() => {
    if (selectedId === undefined) return { nodes: [], edges: [] };
    const visible = new Set([selectedId]);
    for (const edge of related) { if (visible.size >= 61) break; visible.add(edge.source); visible.add(edge.target); }
    const edges: Edge[] = related.filter((edge) => visible.has(edge.source) && visible.has(edge.target)).map((edge, index) => ({ id: `dep-${index}`, source: edge.source, target: edge.target,
      label: `${edge.inferred ? "推断 · " : ""}${edge.count} 处`, markerEnd: { type: MarkerType.ArrowClosed, color: edge.inferred ? "var(--atlas-ref-inferred)" : "var(--atlas-ref-exact)" },
      style: { stroke: edge.inferred ? "var(--atlas-ref-inferred)" : "var(--atlas-ref-exact)", strokeDasharray: edge.inferred ? "5 4" : undefined },
      labelStyle: { fill: "var(--atlas-text)", fontSize: 12 }, labelBgStyle: { fill: "var(--atlas-canvas)" } }));
    const layout = new dagre.graphlib.Graph(); layout.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 80 }); layout.setDefaultEdgeLabel(() => ({}));
    for (const id of visible) layout.setNode(id, { width: 220, height: 78 });
    for (const edge of edges) layout.setEdge(edge.source, edge.target);
    dagre.layout(layout);
    const nodes: Node[] = [...visible].map((id) => {
      const group = model.groups.get(id)!, position = layout.node(id);
      return { id, position: { x: position.x - 110, y: position.y - 39 }, sourcePosition: Position.Right, targetPosition: Position.Left,
        data: { label: <div title={group.label} className="text-left"><div className="truncate text-sm font-semibold">{group.label.split("/").at(-1)}</div><div className="mt-1 truncate text-xs text-slate-400">{level === "file" ? group.label : `${group.files.length} 个文件 · ${group.label}`}</div></div> },
        style: { width: 220, height: 78, padding: 12, background: "var(--atlas-surface)", color: "var(--atlas-text)", border: `1px solid ${id === selectedId ? "var(--atlas-clay)" : "var(--atlas-border)"}`, borderRadius: 10 } };
    });
    return { nodes, edges };
  })();
  return { model, options, selected, related, graph };
  }, [data, level, includeInferred, selection, query, direction]);
  const cycles = includeInferred ? data.possibleCycles : data.cycles;
  const selectedFiles = new Set(selected?.files.map((file) => file.id));
  const boundaries = data.boundaries.filter((item) => selectedFiles.has(item.fileId));
  if (!data.files.length) return <p className="p-6 text-sm text-slate-400">暂无文件，请导入源码或重新扫描。</p>;
  return <div className="space-y-4">
    <p className="text-xs leading-6 text-slate-400">箭头 A → B 表示 A 静态导入 B，不表示调用或执行顺序。绿色实线为已解析目标，蓝色虚线为推断；部分包导入只能定位代表文件，不能据此视为完整包依赖。</p>
    {data.truncated && <p role="status" className="text-sm text-amber-300">关系超过展示限额，当前为部分结果；循环检测也仅覆盖这些关系。</p>}
    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
      <label>层级 <select aria-label="依赖视图层级" value={level} onChange={(event) => { setLevel(event.target.value); setSelection(""); }} className="rounded border border-slate-700 bg-slate-900 p-2"><option value="file">文件</option><option value="directory">目录聚合</option></select></label>
      <label>方向 <select aria-label="依赖方向" value={direction} onChange={(event) => setDirection(event.target.value)} className="rounded border border-slate-700 bg-slate-900 p-2"><option value="both">导入与被导入</option><option value="outgoing">它导入谁</option><option value="incoming">谁导入它</option></select></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={includeInferred} onChange={(event) => setIncludeInferred(event.target.checked)} />包含推断目标</label>
    </div>
    <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="min-w-0"><input aria-label="查找依赖文件或目录" placeholder="筛选文件 / 目录…" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm" /><div className="mt-2 max-h-96 space-y-1 overflow-y-auto">{options.slice(0, 200).map((group) => <button key={group.id} onClick={() => setSelection(group.id)} title={group.label} aria-pressed={selected?.id === group.id} className={`block w-full truncate rounded p-2 text-left text-xs ${selected?.id === group.id ? "bg-indigo-500/15 text-indigo-200" : "text-slate-400 hover:bg-slate-800"}`}>{group.label}</button>)}{options.length > 200 && <p className="text-xs text-slate-500">只列出前 200 项，请缩小筛选范围。</p>}{!options.length && <p className="p-3 text-xs text-slate-500">没有匹配项</p>}</div></div>
      <div className="min-w-0"><div className="h-[440px] overflow-hidden rounded-xl border border-slate-700" aria-label="文件依赖图">
        {selected ? <ReactFlow key={`${level}:${selected.id}:${direction}:${includeInferred}`} nodes={graph.nodes} edges={graph.edges} colorMode={theme} fitView fitViewOptions={{ maxZoom: 1 }} nodesDraggable={false} nodesConnectable={false} minZoom={.1} onNodeClick={(_, node) => setSelection(node.id)}><Background color="var(--atlas-border)" /><Controls showInteractive={false} /></ReactFlow> : <p className="p-6 text-sm text-slate-400">选择文件查看依赖。</p>}
      </div><p className="mt-2 text-xs text-slate-500">当前显示所选节点的一层邻居，最多 61 个节点；点击节点继续追踪链路。{related.length === 0 && " 当前筛选下没有项目内导入关系。"}</p></div>
    </div>
    {selected && <section className="rounded-xl border border-slate-700 p-4"><h3 className="break-all text-sm font-semibold">{selected.label}</h3><div className="mt-3 flex flex-wrap gap-2">{selected.files.slice(0, 12).map((file) => <button key={file.id} disabled={file.symbolId === null} onClick={() => { if (file.symbolId !== null) onRead(file.symbolId); }} className="rounded border border-slate-700 px-3 py-2 text-xs text-indigo-300 disabled:text-slate-500">{file.path.split("/").at(-1)} · {file.symbolId === null ? "无可导航符号" : "阅读源码"}</button>)}</div>
      <p className="mt-3 text-xs text-slate-500">外部 / 未解析导入 {boundaries.length} 项{boundaries.length > 20 ? "（仅列前 20 项）" : ""}</p><ul className="mt-2 space-y-1 text-xs text-slate-400">{boundaries.slice(0, 20).map((item, index) => <li key={index} className="break-all">L{item.line} · {item.specifier} · {item.kind === "external" ? "外部依赖" : "无法解析"}{item.reason ? `：${item.reason}` : ""}</li>)}</ul>
    </section>}
    <section><h3 className="text-sm font-semibold">{includeInferred ? "包含推断边的循环依赖组" : "已解析边中的循环依赖组"} · {cycles.length}</h3><p className="mt-1 text-xs leading-5 text-slate-500">组内存在依赖循环，列表顺序不是环路顺序；包含推断边时仅作为可能的循环。目录内部边在聚合图中省略，循环检测仍按文件进行。</p><ul className="mt-2 space-y-2">{cycles.slice(0, 20).map((group, index) => <li key={index} className="flex flex-wrap gap-2 rounded border border-slate-800 p-3">{group.slice(0, 20).map((id) => <button key={id} onClick={() => { setSelection(model.fileGroup.get(id)!); setQuery(""); }} className="break-all text-xs text-indigo-300">{data.files.find((file) => file.id === id)?.path}</button>)}{group.length > 20 && <span className="text-xs text-slate-500">另 {group.length - 20} 个文件</span>}</li>)}</ul>{!cycles.length && <p className="mt-2 text-xs text-slate-500">当前快照和筛选范围内未发现循环。</p>}{cycles.length > 20 && <p className="text-xs text-slate-500">仅列前 20 个循环组。</p>}</section>
  </div>;
}
