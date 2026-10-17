import type { CallTreeBranch, CallTreePage, CallTreeSymbol } from "../api-types.ts";
import type { ResolutionT } from "../shared.ts";

export interface CallTreeLoad {
  page?: CallTreePage;
  loading?: boolean;
  error?: string;
}
export interface CallTreeOccurrence {
  id: string;
  type: "symbol" | "candidates" | "terminal" | "more" | "status";
  label: string;
  subtitle: string;
  symbol?: CallTreeSymbol;
  resolution?: ResolutionT;
  reason?: string;
  ownerId?: number;
  refId?: number;
  cycle?: boolean;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  loading?: boolean;
  error?: string;
}

export function buildCallTree(root: CallTreeSymbol, pages: ReadonlyMap<number, CallTreeLoad>, expanded: ReadonlySet<string>, showTerminals = true, maxNodes = 180) {
  const nodes: CallTreeOccurrence[] = [];
  const edges: { id: string; source: string; target: string; resolution?: ResolutionT }[] = [];
  let truncated = false;
  function add(node: CallTreeOccurrence, parent?: string): boolean {
    if (nodes.length >= maxNodes) { truncated = true; return false; }
    nodes.push(node);
    if (parent) edges.push({ id: node.id, source: parent, target: node.id, resolution: node.resolution });
    return true;
  }
  function visit(symbol: CallTreeSymbol, id: string, ancestors: number[], depth: number, parent?: string, via?: CallTreeBranch, confidence?: ResolutionT) {
    const load = pages.get(symbol.id);
    const cycle = ancestors.includes(symbol.id);
    const open = expanded.has(id) && !cycle && depth < 8;
    const expandable = !cycle && depth < 8 && (!load?.page || load.page.branches.length > 0);
    if (!add({ id, type: "symbol", label: symbol.name, subtitle: `${symbol.filePath}:L${symbol.line}`, symbol, cycle, depth, expandable, expanded: open,
      resolution: confidence ?? via?.resolution, reason: cycle ? "该方法已在当前路径中出现，停止展开以避免循环。" : depth >= 8 ? "已到达当前探索深度，可将该方法设为新起点继续。" : via ? `调用点 ${via.filePath}:L${via.line} · ${via.reason}` : undefined,
      ownerId: parent ? ancestors.at(-1) : undefined, refId: via?.refId, loading: load?.loading, error: load?.error }, parent)) return;
    if (!open) return;
    if (!load?.page) {
      add({ id: `${id}/status`, type: "status", label: load?.error ? "加载失败，点击重试" : "正在加载调用…", subtitle: load?.error ?? "只读取此方法的直接调用", depth: depth + 1, expandable: false, expanded: false, ownerId: symbol.id, error: load?.error, loading: load?.loading }, id);
      return;
    }
    const visible = load.page.branches.filter((branch) => showTerminals || branch.targets.length > 0);
    for (const branch of visible) {
      const branchId = `${id}/r${branch.refId}`;
      if (branch.targets.length === 1) {
        const target = branch.targets[0];
        visit(target.symbol, `${branchId}/s${target.symbol.id}`, [...ancestors, symbol.id], depth + 1, id, branch, target.confidence);
      } else if (branch.targets.length > 1) {
        const opened = expanded.has(branchId);
        if (!add({ id: branchId, type: "candidates", label: branch.label, subtitle: `${branch.targets.length} 个候选 · ${branch.filePath}:L${branch.line}`, depth: depth + 1,
          expandable: true, expanded: opened, resolution: "heuristic", reason: branch.reason, ownerId: symbol.id, refId: branch.refId }, id)) break;
        if (opened) for (const target of branch.targets) visit(target.symbol, `${branchId}/s${target.symbol.id}`, [...ancestors, symbol.id], depth + 2, branchId, branch, target.confidence);
      } else {
        if (!add({ id: branchId, type: "terminal", label: branch.label, subtitle: `${branch.filePath}:L${branch.line}`, depth: depth + 1,
          expandable: false, expanded: false, resolution: branch.resolution, reason: branch.reason, ownerId: symbol.id, refId: branch.refId }, id)) break;
      }
      if (truncated) break;
    }
    if (!visible.length && load.page.nextOffset === null) add({ id: `${id}/end`, type: "status", label: load.page.branches.length ? "没有可显示的项目内调用" : load.page.direction === "incoming" ? "尚未找到项目内调用方" : load.page.scope === "project" ? "没有找到项目内直接调用" : "没有记录到直接调用",
      subtitle: load.page.branches.length || load.page.scope === "project" && load.page.direction === "outgoing" ? "可启用外部 / 未解析调用" : "静态分析结果不等于运行时完整流程", depth: depth + 1, expandable: false, expanded: false }, id);
    if (load.page.nextOffset !== null) add({ id: `${id}/more`, type: "more", label: load.error ? "加载更多失败，点击重试" : "加载更多调用", subtitle: "继续查看此方法的其他调用位置", depth: depth + 1,
      expandable: false, expanded: false, ownerId: symbol.id, loading: load.loading, error: load.error }, id);
  }
  visit(root, "root", [], 0);
  return { nodes, edges, truncated };
}
