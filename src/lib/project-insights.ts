import type { FileImportInfo, ProjectStats } from "./shared.ts";

export interface DependencyFile { id: number; path: string; language: string; isTest: boolean; symbolId: number | null }
export interface DependencyEdge { id: string; source: number; target: number; inferred: boolean; count: number; lines: number[]; specifiers: string[] }
export interface DependencyBoundary { fileId: number; specifier: string; kind: "external" | "unresolved"; reason: string | null; line: number }
export interface DependencyData {
  files: DependencyFile[]; edges: DependencyEdge[]; boundaries: DependencyBoundary[];
  cycles: number[][]; possibleCycles: number[][]; truncated: boolean;
}
export interface InsightSymbol {
  id: number; fileId: number; parentId: number | null; name: string; qualifiedName: string; kind: string; startLine: number;
  isTest: boolean; complexity: number; loc: number; decorators: string[]; bases: string[];
}
export interface LearningItem { id: number; name: string; path: string; line: number; complexity: number; loc: number; exactCallers: number; inferredCallers: number; candidateCallers: number }
export interface LearningData { methodCount: number; distribution: { label: string; count: number }[]; complex: LearningItem[]; referenced: LearningItem[]; large: LearningItem[] }
export interface ProjectInsights { dependencies: DependencyData; learning: LearningData; scan: ProjectStats["scanTimings"] | null }

/** Iterative SCC avoids overflowing the stack on large import chains. */
export function dependencyCycles(ids: number[], edges: DependencyEdge[]): number[][] {
  const outgoing = new Map(ids.map((id) => [id, [] as number[]]));
  const incoming = new Map(ids.map((id) => [id, [] as number[]]));
  for (const edge of edges) { outgoing.get(edge.source)?.push(edge.target); incoming.get(edge.target)?.push(edge.source); }
  const visited = new Set<number>(), order: number[] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: [number, number][] = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1], children = outgoing.get(top[0]) ?? [];
      if (top[1] < children.length) {
        const next = children[top[1]++];
        if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
      } else { order.push(top[0]); stack.pop(); }
    }
  }
  visited.clear();
  const groups: number[][] = [];
  for (const start of order.reverse()) {
    if (visited.has(start)) continue;
    const group: number[] = [], stack = [start]; visited.add(start);
    while (stack.length) {
      const id = stack.pop()!; group.push(id);
      for (const next of incoming.get(id) ?? []) if (!visited.has(next)) { visited.add(next); stack.push(next); }
    }
    if (group.length > 1 || outgoing.get(start)?.includes(start)) groups.push(group.sort((a, b) => a - b));
  }
  return groups.sort((a, b) => b.length - a.length || a[0] - b[0]);
}

export function buildDependencies(rows: (DependencyFile & { imports: FileImportInfo[] })[], edgeLimit = 20000): DependencyData {
  const byPath = new Map(rows.map((file) => [file.path, file.id]));
  const edges = new Map<string, DependencyEdge>();
  const boundaries: DependencyBoundary[] = [];
  let truncated = false;
  for (const file of rows) for (const item of file.imports) {
    const target = item.resolvedPath === null ? undefined : byPath.get(item.resolvedPath);
    if (item.kind !== "project" || target === undefined) {
      if (boundaries.length < edgeLimit) boundaries.push({ fileId: file.id, specifier: item.specifier, line: item.line,
        kind: item.kind === "external" ? "external" : "unresolved", reason: item.reason ?? (item.kind === "project" ? "快照中没有对应目标文件" : null) });
      else truncated = true;
      continue;
    }
    const id = `${file.id}:${target}:${item.guess ? "inferred" : "exact"}`;
    let edge = edges.get(id);
    if (!edge) {
      if (edges.size >= edgeLimit) { truncated = true; continue; }
      edge = { id, source: file.id, target, inferred: item.guess, count: 0, lines: [], specifiers: [] }; edges.set(id, edge);
    }
    edge.count++;
    if (edge.lines.length < 20 && !edge.lines.includes(item.line)) edge.lines.push(item.line);
    if (edge.specifiers.length < 20 && !edge.specifiers.includes(item.specifier)) edge.specifiers.push(item.specifier);
  }
  const all = [...edges.values()], ids = rows.map((file) => file.id);
  return { files: rows.map(({ imports: _imports, ...file }) => file), edges: all, boundaries,
    cycles: dependencyCycles(ids, all.filter((edge) => !edge.inferred)), possibleCycles: dependencyCycles(ids, all), truncated };
}

export function buildLearning(files: DependencyFile[], symbols: InsightSymbol[], calls: { target: number; owner: number; confidence: string }[]): LearningData {
  const byFile = new Map(files.map((file) => [file.id, file]));
  const callers = new Map<number, Record<string, Set<number>>>();
  for (const call of calls) {
    const groups = callers.get(call.target) ?? {}; (groups[call.confidence] ??= new Set()).add(call.owner); callers.set(call.target, groups);
  }
  const methods: LearningItem[] = symbols.filter((symbol) => ["function", "method"].includes(symbol.kind) && !symbol.isTest && !byFile.get(symbol.fileId)?.isTest).map((symbol) => ({
    id: symbol.id, name: symbol.qualifiedName, path: byFile.get(symbol.fileId)?.path ?? "", line: symbol.startLine, complexity: symbol.complexity, loc: symbol.loc,
    exactCallers: callers.get(symbol.id)?.exact?.size ?? 0, inferredCallers: callers.get(symbol.id)?.inferred?.size ?? 0, candidateCallers: callers.get(symbol.id)?.heuristic?.size ?? 0,
  }));
  const tie = (a: LearningItem, b: LearningItem) => a.path.localeCompare(b.path) || a.line - b.line || a.id - b.id;
  return { methodCount: methods.length, distribution: [
    { label: "1–5", count: methods.filter((item) => item.complexity <= 5).length },
    { label: "6–10", count: methods.filter((item) => item.complexity > 5 && item.complexity <= 10).length },
    { label: "11–20", count: methods.filter((item) => item.complexity > 10 && item.complexity <= 20).length },
    { label: "21+", count: methods.filter((item) => item.complexity > 20).length },
  ], complex: [...methods].sort((a, b) => b.complexity - a.complexity || tie(a, b)).slice(0, 20),
    referenced: methods.filter((item) => item.exactCallers > 0).sort((a, b) => b.exactCallers - a.exactCallers || tie(a, b)).slice(0, 20),
    large: [...methods].sort((a, b) => b.loc - a.loc || tie(a, b)).slice(0, 20) };
}
