import type { SymbolMetrics, SyntaxNode, VariableInfo, VariableKind } from "./types.ts";

export function slice(source: string, n: SyntaxNode): string {
  return source.slice(n.startIndex, n.endIndex);
}

export function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function rangeOf(n: SyntaxNode) {
  return {
    startLine: n.startPosition.row + 1,
    startCol: n.startPosition.column + 1,
    endLine: n.endPosition.row + 1,
    endCol: n.endPosition.column + 1,
    startIndex: n.startIndex,
    endIndex: n.endIndex,
  };
}

/** 先序遍历；visit 返回 false 时跳过子树 */
export function walk(root: SyntaxNode, visit: (n: SyntaxNode) => boolean | void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (visit(n) === false) continue;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
}

export function findNodeByRange(root: SyntaxNode, start: number, end: number): SyntaxNode | null {
  const n = root.descendantForIndex(start, end);
  if (n && n.startIndex === start && n.endIndex === end) return n;
  // 兜底：向上查找范围一致的节点
  let cur: SyntaxNode | null = n;
  while (cur) {
    if (cur.startIndex === start && cur.endIndex === end) return cur;
    cur = cur.parent;
  }
  return null;
}

export function hasAncestor(n: SyntaxNode, pred: (a: SyntaxNode) => boolean, stopAt?: SyntaxNode): boolean {
  let cur = n.parent;
  while (cur) {
    if (stopAt && cur.id === stopAt.id) return false;
    if (pred(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/* ---------------- 度量 ---------------- */

export interface MetricConfig {
  isBranch(n: SyntaxNode): boolean;
  isLoop(n: SyntaxNode): boolean;
  isHandler(n: SyntaxNode): boolean;
  isReturn(n: SyntaxNode): boolean;
  isThrow(n: SyntaxNode): boolean;
  isAwait(n: SyntaxNode): boolean;
  isBoolOp(n: SyntaxNode): boolean;
  isYield(n: SyntaxNode): boolean;
  /** 嵌套定义（不计入当前方法的度量） */
  isNestedDef(n: SyntaxNode): boolean;
}

export function computeMetrics(
  def: SyntaxNode,
  cfg: MetricConfig,
  paramCount: number,
): { metrics: SymbolMetrics; isGenerator: boolean } {
  const m: SymbolMetrics = {
    loc: def.endPosition.row - def.startPosition.row + 1,
    params: paramCount,
    branches: 0,
    loops: 0,
    handlers: 0,
    returns: 0,
    throws: 0,
    awaits: 0,
    booleanOps: 0,
    complexity: 1,
  };
  let isGenerator = false;
  walk(def, (n) => {
    if (n.id !== def.id && cfg.isNestedDef(n)) return false;
    if (cfg.isBranch(n)) m.branches++;
    else if (cfg.isLoop(n)) m.loops++;
    else if (cfg.isHandler(n)) m.handlers++;
    else if (cfg.isReturn(n)) m.returns++;
    else if (cfg.isThrow(n)) m.throws++;
    else if (cfg.isAwait(n)) m.awaits++;
    else if (cfg.isBoolOp(n)) m.booleanOps++;
    else if (cfg.isYield(n)) isGenerator = true;
    return true;
  });
  m.complexity = 1 + m.branches + m.loops + m.handlers + m.booleanOps;
  return { metrics: m, isGenerator };
}

/** 收集一组节点内部的调用被调文本（不进入嵌套定义），用于流程图标注 */
export function collectCallNames(
  nodes: (SyntaxNode | null | undefined)[],
  source: string,
  callTypes: Record<string, string>, // 节点类型 -> 被调字段名
  skip: (n: SyntaxNode) => boolean,
  limit = 4,
): string[] {
  const out: string[] = [];
  for (const root of nodes) {
    if (!root) continue;
    walk(root, (n) => {
      if (out.length >= limit) return false;
      if (n.id !== root.id && skip(n)) return false;
      const field = callTypes[n.type];
      if (field) {
        const callee = n.childForFieldName(field);
        if (callee) {
          const t = oneLine(slice(source, callee), 40);
          if (!out.includes(t)) out.push(t);
        }
      }
      return true;
    });
  }
  return out;
}

/* ---------------- 变量收集 ---------------- */

interface DeclInfo {
  kind: VariableKind;
  typeText: string | null;
  declKeyword: string | null;
  node: SyntaxNode | null;
  snippet: string | null;
  where: "method" | "class";
}

interface Occ {
  name: string;
  node: SyntaxNode;
  access: "def" | "read" | "write";
  tags: string[];
}

export class VarCollector {
  private decls = new Map<string, DeclInfo>();
  private occs: Occ[] = [];
  private fieldDefs = new Map<
    string,
    { line: number; col: number; endCol: number; snippet: string; where: "method" | "class" } | string
  >();

  isDeclared(name: string) {
    return this.decls.has(name);
  }

  declare(
    name: string,
    node: SyntaxNode,
    info: { kind: VariableKind; typeText?: string | null; declKeyword?: string | null; snippet?: string | null },
  ) {
    if (this.decls.has(name)) {
      this.occs.push({ name, node, access: "write", tags: [] });
      return;
    }
    this.decls.set(name, {
      kind: info.kind,
      typeText: info.typeText ?? null,
      declKeyword: info.declKeyword ?? null,
      node,
      snippet: info.snippet ?? null,
      where: "method",
    });
    this.occs.push({ name, node, access: "def", tags: [] });
  }

  /** 字段（self.x / this.x）在当前方法内的出现 */
  declareField(name: string, typeText?: string | null) {
    if (!this.decls.has(name)) {
      this.decls.set(name, {
        kind: "field",
        typeText: typeText ?? null,
        declKeyword: null,
        node: null,
        snippet: null,
        where: "method",
      });
    }
  }

  setFieldDefinition(
    name: string,
    def: { line: number; col: number; endCol: number; snippet: string; where: "method" | "class" } | string,
  ) {
    this.fieldDefs.set(name, def);
  }

  occur(name: string, node: SyntaxNode, access: "read" | "write", tags: string[] = []) {
    this.occs.push({ name, node, access, tags });
  }

  build(source: string): VariableInfo[] {
    const byName = new Map<string, Occ[]>();
    for (const o of this.occs) {
      if (!this.decls.has(o.name)) continue;
      const list = byName.get(o.name) ?? [];
      list.push(o);
      byName.set(o.name, list);
    }
    const out: VariableInfo[] = [];
    for (const [name, d] of this.decls) {
      const occs = (byName.get(name) ?? []).slice().sort((a, b) => a.node.startIndex - b.node.startIndex);
      const seen = new Set<number>();
      const occurrences = occs
        .filter((o) => {
          const key = o.node.startIndex * 4 + (o.access === "def" ? 1 : 0);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((o) => ({
          line: o.node.startPosition.row + 1,
          col: o.node.startPosition.column + 1,
          endCol: o.node.endPosition.column + 1,
          access: o.access,
        }));
      const tags = new Set<string>();
      for (const o of occs) for (const t of o.tags) tags.add(t);
      const readCount = occurrences.filter((o) => o.access === "read").length;
      const writeCount = occurrences.filter((o) => o.access === "write").length;
      let definition: VariableInfo["definition"] = null;
      let definitionNote: string | null = null;
      if (d.node) {
        definition = {
          line: d.node.startPosition.row + 1,
          col: d.node.startPosition.column + 1,
          endCol: d.node.endPosition.column + 1,
          snippet: d.snippet ?? oneLine(source.slice(d.node.startIndex, d.node.endIndex), 100),
          where: d.where,
        };
      } else if (d.kind === "field") {
        const fd = this.fieldDefs.get(name);
        if (typeof fd === "string") definitionNote = fd;
        else if (fd) definition = fd;
        else definitionNote = "未在本类中找到该字段的赋值（可能来自基类或动态设置）";
      }
      let importance = d.kind === "param" ? 3 : d.kind === "field" ? 1.5 : 1;
      if (tags.has("returned")) importance += 3;
      if (tags.has("condition")) importance += 2;
      importance += Math.min(occurrences.length, 8) * 0.3;
      out.push({
        name,
        kind: d.kind,
        typeText: d.typeText,
        declKeyword: d.declKeyword,
        definition,
        definitionNote,
        occurrences,
        readCount,
        writeCount,
        tags: [...tags],
        importance: Math.round(importance * 10) / 10,
      });
    }
    out.sort((a, b) => b.importance - a.importance || (a.definition?.line ?? 1e9) - (b.definition?.line ?? 1e9));
    return out;
  }
}

/** 向上查找，判断 node 是否位于某祖先节点的指定字段内 */
export function inFieldOf(
  node: SyntaxNode,
  ancestorTypes: string[],
  field: string,
  stopAt: SyntaxNode,
): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur && cur.id !== stopAt.id) {
    const p: SyntaxNode | null = cur.parent;
    if (!p) return null;
    if (ancestorTypes.includes(p.type)) {
      const f = p.childForFieldName(field);
      if (f && f.id === cur.id) return p;
    }
    cur = p;
  }
  return null;
}

export function typeNameFromAnnotation(text: string | null | undefined): string | null {
  if (!text) return null;
  let t = text.trim().replace(/^:\s*/, "").replace(/^["']|["']$/g, "");
  t = t.replace(/\bOptional\[(.*)\]$/, "$1");
  t = t.replace(/\s*\|\s*(None|null|undefined)\b/g, "").replace(/\b(None|null|undefined)\s*\|\s*/g, "");
  t = t.replace(/<.*>$/, "").replace(/\[.*\]$/, "");
  t = t.trim();
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t)) return null;
  const last = t.split(".").pop()!;
  if (/^(str|int|float|bool|list|dict|set|tuple|bytes|string|number|boolean|any|unknown|void|object|never|None|null|undefined|Any|Array|Promise|Record)$/.test(last)) return null;
  return last;
}
