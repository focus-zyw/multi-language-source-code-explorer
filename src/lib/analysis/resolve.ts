import type {
  Confidence,
  ExtractResult,
  ExtractedCall,
  ExtractedSymbol,
  FileIndex,
  ImportBinding,
  LanguageId,
  LanguagePlugin,
  Resolution,
  TypeHint,
} from "./types.ts";

export interface FileUnit {
  idx: number;
  path: string;
  language: LanguageId;
  plugin: LanguagePlugin;
  extract: ExtractResult;
  isTest: boolean;
}

export interface SymRec {
  id: number;
  fileIdx: number;
  sym: ExtractedSymbol;
}

export interface ResolvedTarget {
  symbolId: number;
  confidence: Confidence;
  score: number;
  reason: string;
}

export interface ResolvedRef {
  ownerSymbolId: number;
  fileIdx: number;
  call: ExtractedCall;
  resolution: Resolution;
  reason: string;
  targets: ResolvedTarget[];
}

export interface ImportInfo {
  specifier: string;
  names: string[];
  line: number;
  kind: "project" | "external" | "unresolved";
  resolvedPath: string | null;
  guess: boolean;
  reason: string | null;
}

export interface ResolveOutput {
  refs: ResolvedRef[];
  imports: ImportInfo[][];
}

type BindingTarget =
  | { kind: "symbol"; rec: SymRec; level: Confidence }
  | { kind: "module"; fileIdx: number; level: Confidence }
  | { kind: "external" }
  | { kind: "unresolved"; reason: string };

interface Outcome {
  resolution: Resolution;
  reason: string;
  targets: ResolvedTarget[];
}

interface FileInfo {
  top: Map<string, SymRec[]>;
  byContainer: Map<string, Map<string, SymRec[]>>;
  bindings: Map<string, ImportBinding[]>;
  bindingByPath: Map<string, ImportBinding>;
  wildcards: ImportBinding[];
  hintsByOwner: Map<number, Map<string, TypeHint | null>>;
  fieldHints: Map<number, Map<string, TypeHint | null>>;
  defaultRec: SymRec | null;
}

const RANK: Record<Confidence, number> = { exact: 3, inferred: 2, heuristic: 1 };
const minLevel = (...ls: Confidence[]): Confidence => ls.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

export function resolveProject(files: FileUnit[], symbolIds: number[][]): ResolveOutput {
  const fileByPath = new Map<string, number>();
  files.forEach((f) => fileByPath.set(f.path, f.idx));
  const allPaths = files.map((f) => f.path);
  const suffixCache = new Map<string, string[]>();
  const index: FileIndex = {
    has: (p) => fileByPath.has(p),
    bySuffix: (s) => {
      let r = suffixCache.get(s);
      if (!r) {
        r = allPaths.filter((p) => p.endsWith(s));
        suffixCache.set(s, r);
      }
      return r;
    },
  };

  const recs: SymRec[][] = files.map((f) => f.extract.symbols.map((sym) => ({ id: symbolIds[f.idx][sym.localId], fileIdx: f.idx, sym })));
  const recById = new Map<number, SymRec>();
  for (const fileRecs of recs) for (const rec of fileRecs) recById.set(rec.id, rec);
  const sameLanguage = (a: number, b: number) => files[a].language === files[b].language || ["javascript", "typescript", "vue"].includes(files[a].language) && ["javascript", "typescript", "vue"].includes(files[b].language);
  const sameGoPackage = (a: number, b: number) => files[a].language === "go" && files[b].language === "go" && dirOf(files[a].path) === dirOf(files[b].path) && !!files[a].extract.moduleName && files[a].extract.moduleName === files[b].extract.moduleName;
  const sameDeclaredNamespace = (a: number, b: number) => {
    const left = files[a], right = files[b];
    return (left.language === "java" || left.language === "csharp") && left.language === right.language && left.extract.moduleName !== undefined && left.extract.moduleName === right.extract.moduleName;
  };
  const infos: FileInfo[] = files.map((f) => {
    const info: FileInfo = {
      top: new Map(),
      byContainer: new Map(),
      bindings: new Map(),
      bindingByPath: new Map(),
      wildcards: [],
      hintsByOwner: new Map(),
      fieldHints: new Map(),
      defaultRec: null,
    };
    for (const r of recs[f.idx]) {
      const s = r.sym;
      if (s.kind === "test") continue;
      if (s.container === null && (s.parentLocalId === null || f.language === "vue" && /^export\s/.test(s.signature))) push(info.top, s.name, r);
      if (s.container !== null && s.kind !== "class") {
        let m = info.byContainer.get(s.container);
        if (!m) info.byContainer.set(s.container, (m = new Map()));
        push(m, s.name, r);
      }
      if (s.isDefaultExport && !info.defaultRec) info.defaultRec = r;
    }
    if (!info.defaultRec && f.extract.defaultExportName) info.defaultRec = info.top.get(f.extract.defaultExportName)?.[0] ?? null;
    for (const b of f.extract.imports) {
      if (b.imported === "*wildcard") info.wildcards.push(b);
      else {
        push(info.bindings, b.local, b);
        if (!info.bindingByPath.has(b.localPath)) info.bindingByPath.set(b.localPath, b);
      }
    }
    for (const h of f.extract.hints) {
      const map = h.field ? info.fieldHints : info.hintsByOwner;
      const key = h.field ? h.classLocalId : h.ownerLocalId;
      if (key === null) continue;
      let m = map.get(key);
      if (!m) map.set(key, (m = new Map()));
      const prev = m.get(h.variable);
      if (prev === undefined) m.set(h.variable, h);
      else if (prev === null) continue;
      else if (prev.typeName !== h.typeName) {
        // 同一变量被赋予不同类型：标注优先，否则放弃推断
        if (prev.source === "annotation") continue;
        m.set(h.variable, h.source === "annotation" ? h : null);
      } else if (h.source === "annotation") m.set(h.variable, h);
    }
    return info;
  });

  const globalTop = new Map<string, SymRec[]>();
  const globalClasses = new Map<string, SymRec[]>();
  const globalMethods = new Map<string, SymRec[]>();
  for (const f of files) {
    for (const r of recs[f.idx]) {
      const s = r.sym;
      if (s.kind === "test") continue;
      if (s.kind === "class") push(globalClasses, s.name, r);
      if (s.parentLocalId === null && s.container === null) push(globalTop, s.name, r);
      if (s.container !== null && s.kind !== "class") push(globalMethods, s.name, r);
    }
  }

  const bindingCache = new Map<string, BindingTarget>();

  const resolveBinding = (fi: number, b: ImportBinding, depth = 0): BindingTarget => {
    const key = `${fi}|${b.local}|${b.specifier}|${b.imported}`;
    const cached = bindingCache.get(key);
    if (cached) return cached;
    if (depth > 6) return { kind: "unresolved", reason: "再导出层级过深" };
    const plugin = files[fi].plugin;
    const mr = plugin.resolveImport(files[fi].path, b.specifier, index);
    let out: BindingTarget;
    if (mr.kind === "external") out = { kind: "external" };
    else if (mr.kind === "unresolved") out = { kind: "unresolved", reason: mr.reason };
    else {
      const target = fileByPath.get(mr.path)!;
      const level: Confidence = mr.guess ? "inferred" : "exact";
      if (b.imported === "*") out = { kind: "module", fileIdx: target, level };
      else {
        const hit = findExport(target, b.imported, depth + 1, new Set());
        if (hit) out = { kind: "symbol", rec: hit.rec, level: minLevel(level, hit.level) };
        else {
          const sub = plugin.joinSubmodule(b.specifier, b.imported);
          const sr = sub ? plugin.resolveImport(files[fi].path, sub, index) : null;
          if (sr && sr.kind === "project") {
            out = { kind: "module", fileIdx: fileByPath.get(sr.path)!, level: sr.guess ? "inferred" : "exact" };
          } else {
            out = { kind: "unresolved", reason: `在 ${mr.path} 中未找到「${b.imported}」的函数/类定义（可能是变量、类型或动态导出）` };
          }
        }
      }
    }
    bindingCache.set(key, out);
    return out;
  };

  const findExport = (fi: number, name: string, depth: number, visited: Set<string>): { rec: SymRec; level: Confidence } | null => {
    if (depth > 6) return null;
    const key = `${fi}:${name}`;
    if (visited.has(key)) return null;
    visited.add(key);
    const fx = infos[fi];
    if (name === "default") return fx.defaultRec ? { rec: fx.defaultRec, level: "exact" } : null;
    const top = fx.top.get(name)?.[0];
    if (top) return { rec: top, level: "exact" };
    if (files[fi].language === "go" || files[fi].language === "java" || files[fi].language === "csharp") {
      const siblings = (globalTop.get(name) ?? []).filter((r) => r.fileIdx !== fi && (sameGoPackage(fi, r.fileIdx) || sameDeclaredNamespace(fi, r.fileIdx)));
      if (siblings.length === 1) return { rec: siblings[0], level: "inferred" };
    }
    if (files[fi].language === "java" || files[fi].language === "csharp") {
      const staticMethods = recs[fi].filter((r) => r.sym.kind === "method" && r.sym.name === name && /\bstatic\b/.test(r.sym.signature));
      if (staticMethods.length === 1) return { rec: staticMethods[0], level: "inferred" };
    }
    for (const b of fx.bindings.get(name) ?? []) {
      const r = resolveBinding(fi, b, depth + 1);
      if (r.kind === "symbol") return { rec: r.rec, level: r.level };
    }
    for (const w of fx.wildcards) {
      const mr = files[fi].plugin.resolveImport(files[fi].path, w.specifier, index);
      if (mr.kind === "project") {
        const hit = findExport(fileByPath.get(mr.path)!, name, depth + 1, visited);
        if (hit) return { rec: hit.rec, level: minLevel(hit.level, mr.guess ? "inferred" : "exact") };
      }
    }
    return null;
  };

  type TypeRes = { rec: SymRec; level: Confidence } | "external" | null;
  const resolveTypeName = (fi: number, name: string): TypeRes => {
    const fx = infos[fi];
    const local = (fx.top.get(name) ?? []).find((r) => r.sym.kind === "class");
    if (local) return { rec: local, level: "exact" };
    const nested = recs[fi].find((r) => r.sym.kind === "class" && r.sym.name === name);
    if (nested) return { rec: nested, level: "exact" };
    for (const b of fx.bindings.get(name) ?? []) {
      const r = resolveBinding(fi, b);
      if (r.kind === "symbol" && r.rec.sym.kind === "class") return { rec: r.rec, level: r.level };
      if (r.kind === "external") return "external";
    }
    for (const w of fx.wildcards) {
      const mr = files[fi].plugin.resolveImport(files[fi].path, w.specifier, index);
      if (mr.kind === "project") {
        const hit = findExport(fileByPath.get(mr.path)!, name, 1, new Set());
        if (hit && hit.rec.sym.kind === "class") return { rec: hit.rec, level: "inferred" };
      }
    }
    if (files[fi].language === "csharp") {
      const namespaces = new Set(fx.wildcards.filter((binding) => binding.localPath !== "*static").map((binding) => binding.specifier));
      const imported = (globalClasses.get(name) ?? []).filter((r) => files[r.fileIdx].language === "csharp" && namespaces.has(files[r.fileIdx].extract.moduleName ?? "\0"));
      if (imported.length === 1) return { rec: imported[0], level: "inferred" };
    }
    const packageClasses = (globalClasses.get(name) ?? []).filter((r) => sameGoPackage(fi, r.fileIdx) || sameDeclaredNamespace(fi, r.fileIdx));
    if (packageClasses.length === 1) return { rec: packageClasses[0], level: "inferred" };
    const g = globalClasses.get(name)?.filter((r) => sameLanguage(fi, r.fileIdx));
    if (g && g.length === 1) return { rec: g[0], level: "heuristic" };
    return null;
  };

  type MethodRes = { rec: SymRec; level: Confidence; via: string | null } | { external: string } | null;
  const lookupMethod = (cls: SymRec, method: string, depth = 0, visited = new Set<number>()): MethodRes => {
    if (visited.has(cls.id) || depth > 8) return null;
    visited.add(cls.id);
    const own = infos[cls.fileIdx].byContainer.get(cls.sym.name)?.get(method)?.[0];
    if (own) return { rec: own, level: "exact", via: depth === 0 ? null : cls.sym.name };
    if (files[cls.fileIdx].language === "go") {
      const siblings = (globalMethods.get(method) ?? []).filter((r) => sameGoPackage(cls.fileIdx, r.fileIdx) && r.sym.container === cls.sym.name);
      if (siblings.length === 1) return { rec: siblings[0], level: "inferred", via: null };
    }
    let externalBase: string | null = null;
    for (const baseText of cls.sym.bases) {
      const baseName = baseText.split(".").pop()!.replace(/<.*$/, "").replace(/\[.*$/, "");
      const base = resolveTypeName(cls.fileIdx, baseName);
      if (base === null || base === "external") {
        externalBase = baseText;
        continue;
      }
      const r = lookupMethod(base.rec, method, depth + 1, visited);
      if (r && "rec" in r) return { rec: r.rec, level: minLevel("inferred", base.level, r.level), via: r.via ?? base.rec.sym.name };
      if (r && "external" in r) externalBase = r.external;
    }
    return externalBase ? { external: externalBase } : null;
  };

  const findHint = (fi: number, owner: ExtractedSymbol, variable: string): TypeHint | null => {
    const fx = infos[fi];
    const syms = files[fi].extract.symbols;
    let cur: ExtractedSymbol | null = owner;
    while (cur) {
      const h = fx.hintsByOwner.get(cur.localId)?.get(variable);
      if (h) return h;
      cur = cur.parentLocalId !== null ? syms[cur.parentLocalId] : null;
    }
    if ((files[fi].language === "java" || files[fi].language === "csharp") && owner.classLocalId !== null) return fx.fieldHints.get(owner.classLocalId)?.get(variable) ?? null;
    return null;
  };

  const ctorOf = (cls: SymRec): { rec: SymRec; note: string } => {
    const plugin = files[cls.fileIdx].plugin;
    const m = infos[cls.fileIdx].byContainer.get(cls.sym.name);
    for (const cn of plugin.constructorNames) {
      const c = m?.get(cn)?.[0];
      if (c) return { rec: c, note: `实例化类 ${cls.sym.name}，目标为其构造方法` };
    }
    return { rec: cls, note: `实例化类 ${cls.sym.name}（类未显式定义构造方法）` };
  };

  const target = (rec: SymRec, confidence: Confidence, reason: string, score?: number): ResolvedTarget => ({
    symbolId: rec.id,
    confidence,
    score: score ?? (confidence === "exact" ? 1 : confidence === "inferred" ? 0.75 : 0.4),
    reason,
  });

  const hit = (fi: number, rec: SymRec, level: Confidence, reason: string): Outcome => {
    let r = rec;
    let why = reason;
    if (rec.sym.kind === "class") {
      const c = ctorOf(rec);
      r = c.rec;
      why = `${reason}；${c.note}`;
    }
    void fi;
    return { resolution: level, reason: why, targets: [target(r, level, why)] };
  };

  const pathOf = (rec: SymRec) => files[rec.fileIdx].path;

  const heuristicByMethod = (fi: number, owner: ExtractedSymbol, call: ExtractedCall, why: string): Outcome => {
    const name = call.name!;
    const plugin = files[fi].plugin;
    const cands = (globalMethods.get(name) ?? []).filter((r) => r.sym.kind !== "test" && sameLanguage(fi, r.fileIdx));
    if (!cands.length) {
      if (plugin.builtinMethods.has(name)) {
        return { resolution: "external", reason: `项目内没有名为 ${name} 的方法；按名称推测为内建/标准库方法（未验证）`, targets: [] };
      }
      return { resolution: "unresolved", reason: `${why}；项目内没有名为 ${name} 的方法，可能来自外部库或动态属性`, targets: [] };
    }
    const recvLower = (call.receiver ?? "").toLowerCase();
    const scored = cands.map((r) => {
      let score = cands.length === 1 ? 0.45 : 0.3;
      const bits: string[] = [];
      if (r.fileIdx === fi) {
        score += 0.2;
        bits.push("同文件");
      } else if (dirOf(pathOf(r)) === dirOf(files[fi].path)) {
        score += 0.08;
        bits.push("同目录");
      }
      const cn = r.sym.container?.toLowerCase();
      if (cn && recvLower && (recvLower.includes(cn) || cn.includes(recvLower.split(".").pop()!))) {
        score += 0.15;
        bits.push("接收者名与类名相近");
      }
      score = Math.min(score, 0.85);
      return { r, score, reason: `${why}；候选 ${r.sym.qualifiedName}（${pathOf(r)}）${bits.length ? "：" + bits.join("、") : ""}` };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    return {
      resolution: "heuristic",
      reason: `${why}；项目内有 ${cands.length} 个同名方法，以下为按名称猜测的候选（未验证）`,
      targets: top.map((s) => target(s.r, "heuristic", s.reason, Math.round(s.score * 100) / 100)),
    };
  };

  const resolveCall = (fi: number, call: ExtractedCall): Outcome => {
    const f = files[fi];
    const fx = infos[fi];
    const plugin = f.plugin;
    const owner = f.extract.symbols[call.ownerLocalId];
    const name = call.name;
    if (!name) return { resolution: "unresolved", reason: "动态/复杂的调用表达式，静态分析无法确定被调对象", targets: [] };

    /* ---------- 无接收者：直接名称 ---------- */
    if (call.receiverKind === null) {
      if ((f.language === "java" || f.language === "csharp") && call.kind !== "new" && owner.classLocalId !== null) {
        const method = lookupMethod(recs[fi][owner.classLocalId], name);
        if (method && "rec" in method) return hit(fi, method.rec, minLevel("inferred", method.level), "按所属类与可解析的继承关系推断方法");
      }
      // 1. 词法作用域内的嵌套定义
      const chain = new Set<number>();
      let cur: ExtractedSymbol | null = owner;
      while (cur) {
        chain.add(cur.localId);
        cur = cur.parentLocalId !== null ? f.extract.symbols[cur.parentLocalId] : null;
      }
      const lexical = recs[fi].find((r) => r.sym.name === name && r.sym.parentLocalId !== null && chain.has(r.sym.parentLocalId) && r.sym.kind !== "method" && r.sym.kind !== "test");
      if (lexical) return hit(fi, lexical, "exact", "在外层函数作用域内定义");
      // 2. 同文件顶层
      const top = fx.top.get(name)?.[0];
      if (top && !fx.bindings.has(name)) return hit(fi, top, "exact", `同文件定义（${f.path}:${top.sym.startLine}）`);
      if (f.language === "go") {
        const siblings = (globalTop.get(name) ?? []).filter((r) => sameGoPackage(fi, r.fileIdx));
        if (siblings.length === 1) return hit(fi, siblings[0], "inferred", "同目录且 package 声明相同（未验证构建标签）");
      }
      // 3. import 绑定
      const bs = fx.bindings.get(name);
      if (bs) {
        for (const b of bs) {
          const r = resolveBinding(fi, b);
          if (r.kind === "symbol") return hit(fi, r.rec, r.level, `通过 import 绑定解析到 ${pathOf(r.rec)}`);
          if (r.kind === "external") return { resolution: "external", reason: `来自外部模块 ${b.specifier}（未在项目内）`, targets: [] };
          if (r.kind === "module") return { resolution: "unresolved", reason: `「${name}」绑定的是整个模块（${files[r.fileIdx].path}），无法确定模块被当作函数调用时的目标`, targets: [] };
        }
        const first = resolveBinding(fi, bs[0]);
        if (first.kind === "unresolved") return { resolution: "unresolved", reason: first.reason, targets: [] };
      }
      if (top) return hit(fi, top, "exact", `同文件定义（${f.path}:${top.sym.startLine}）`);
      // 4. 通配导入
      for (const w of fx.wildcards) {
        const mr = plugin.resolveImport(f.path, w.specifier, index);
        if (mr.kind === "project") {
          const ex = findExport(fileByPath.get(mr.path)!, name, 1, new Set());
          if (ex) return hit(fi, ex.rec, minLevel("inferred", ex.level), `通过 \`from ${w.specifier} import *\` 推断解析到 ${pathOf(ex.rec)}`);
        }
      }
      // 5. 内建 / 全局
      if (plugin.builtinFunctions.has(name)) return { resolution: "external", reason: "语言内建或运行时全局函数/类", targets: [] };
      // 6. 项目内同名（启发式）
      const g = (globalTop.get(name) ?? []).filter((r) => (r.sym.kind === "function" || r.sym.kind === "class") && sameLanguage(fi, r.fileIdx));
      if (g.length === 1) {
        const o = hit(fi, g[0], "heuristic", `项目内唯一同名定义（${pathOf(g[0])}），但当前文件未显式导入/定义，仅为猜测`);
        o.targets[0].score = 0.5;
        return o;
      }
      if (g.length > 1) {
        return {
          resolution: "heuristic",
          reason: `项目内有 ${g.length} 个同名定义，且当前文件未导入，无法确定`,
          targets: g.slice(0, 5).map((r) => {
            const same = dirOf(pathOf(r)) === dirOf(f.path);
            return target(r.sym.kind === "class" ? ctorOf(r).rec : r, "heuristic", `候选 ${r.sym.qualifiedName}（${pathOf(r)}）`, same ? 0.4 : 0.3);
          }),
        };
      }
      return { resolution: "unresolved", reason: "未找到同名定义；可能来自动态定义、外部库或被分析范围之外的代码", targets: [] };
    }

    /* ---------- self / this ---------- */
    if (call.receiverKind === "self") {
      if (owner.classLocalId === null) return heuristicByMethod(fi, owner, call, `${call.receiver} 不在类内，无法确定类型`);
      const cls = recs[fi][owner.classLocalId];
      const m = lookupMethod(cls, name);
      if (m && "rec" in m) {
        const via = m.via ? `（继承自 ${m.via}）` : "";
        return {
          resolution: m.level,
          reason: `${call.receiver}.${name} → 所属类 ${cls.sym.name} 的方法${via}`,
          targets: [target(m.rec, m.level, `同类方法 ${m.rec.sym.qualifiedName}${via}`)],
        };
      }
      if (m && "external" in m) return { resolution: "external", reason: `类 ${cls.sym.name} 未定义 ${name}，可能继承自外部基类 ${m.external}`, targets: [] };
      return { resolution: "unresolved", reason: `类 ${cls.sym.name} 及其可解析的基类中未找到方法 ${name}（可能是动态属性或回调字段）`, targets: [] };
    }

    /* ---------- super ---------- */
    if (call.receiverKind === "super") {
      if (owner.classLocalId === null) return { resolution: "unresolved", reason: "super 不在类内", targets: [] };
      const cls = recs[fi][owner.classLocalId];
      let ext: string | null = null;
      for (const baseText of cls.sym.bases) {
        const baseName = baseText.split(".").pop()!;
        const base = resolveTypeName(fi, baseName);
        if (base === null || base === "external") {
          ext = baseText;
          continue;
        }
        if (name === "constructor" || name === "__init__") {
          const c = ctorOf(base.rec);
          return { resolution: minLevel("inferred", base.level), reason: `super → 基类 ${baseText} 的构造`, targets: [target(c.rec, minLevel("inferred", base.level), `基类 ${baseText} 构造`)] };
        }
        const m = lookupMethod(base.rec, name);
        if (m && "rec" in m) {
          const lvl = minLevel("inferred", base.level, m.level);
          return { resolution: lvl, reason: `super.${name} → 基类 ${baseText}`, targets: [target(m.rec, lvl, `基类方法 ${m.rec.sym.qualifiedName}`)] };
        }
        if (m && "external" in m) ext = m.external;
      }
      if (ext) return { resolution: "external", reason: `基类 ${ext} 不在项目内`, targets: [] };
      return { resolution: "unresolved", reason: `未能在基类中找到 ${name}`, targets: [] };
    }

    /* ---------- 复杂接收者 ---------- */
    if (call.receiverKind === "expr") {
      const rootIdent = /^[A-Za-z_$][\w$]*/.exec(call.receiver ?? "")?.[0];
      if (rootIdent && (plugin.builtinFunctions.has(rootIdent) || plugin.globalObjects.has(rootIdent)) && !fx.top.has(rootIdent) && !fx.bindings.has(rootIdent)) {
        return { resolution: "external", reason: `接收者是内建/全局 API「${rootIdent}」的返回值（如断言库或标准库链式调用）`, targets: [] };
      }
      return heuristicByMethod(fi, owner, call, `接收者是复杂表达式（${call.receiver}），无法推断类型`);
    }

    /* ---------- 名称链接收者：a / a.b / self.x ---------- */
    const recv = call.receiver!;
    const parts = recv.split(".");
    const root = parts[0];

    if (["self", "cls", "this"].includes(root)) {
      if (parts.length === 2 && owner.classLocalId !== null) {
        const h = fx.fieldHints.get(owner.classLocalId)?.get(parts[1]);
        if (h) {
          const t = resolveTypeName(fi, h.typeName);
          if (t && t !== "external") {
            const m = lookupMethod(t.rec, name);
            if (m && "rec" in m) {
              const lvl = minLevel("inferred", t.level, m.level);
              return {
                resolution: lvl,
                reason: `字段 ${recv} 的类型由${h.source === "annotation" ? "类型标注" : "构造调用"}推断为 ${h.typeName}`,
                targets: [target(m.rec, lvl, `${h.typeName}.${name}（推断）`)],
              };
            }
          } else if (t === "external") {
            return { resolution: "external", reason: `字段 ${recv} 的类型 ${h.typeName} 来自外部模块`, targets: [] };
          }
        }
      }
      return heuristicByMethod(fi, owner, call, `无法确定 ${recv} 的类型`);
    }

    // 整个接收者匹配 import（Python `import a.b`、JS 命名空间导入）
    const pathBinding = fx.bindingByPath.get(recv);
    const rootBindings = fx.bindings.get(root);
    const binding = pathBinding && pathBinding.imported === "*" ? pathBinding : parts.length === 1 ? rootBindings?.[0] : undefined;
    if (binding) {
      const r = resolveBinding(fi, binding);
      if (r.kind === "external") return { resolution: "external", reason: `${recv} 来自外部模块 ${binding.specifier}`, targets: [] };
      if (r.kind === "unresolved") return { resolution: "unresolved", reason: r.reason, targets: [] };
      if (r.kind === "module") {
        const ex = findExport(r.fileIdx, name, 1, new Set());
        if (ex) return hit(fi, ex.rec, minLevel(r.level, ex.level), `模块 ${recv}（${files[r.fileIdx].path}）中的定义`);
        return { resolution: "unresolved", reason: `模块 ${files[r.fileIdx].path} 中未找到 ${name} 的函数/类定义`, targets: [] };
      }
      if (r.kind === "symbol" && r.rec.sym.kind === "class") {
        const m = lookupMethod(r.rec, name);
        if (m && "rec" in m) {
          const lvl = minLevel(r.level, m.level);
          return { resolution: lvl, reason: `${recv} 是导入的类 ${r.rec.sym.name}，调用其方法`, targets: [target(m.rec, lvl, `${r.rec.sym.name}.${name}`)] };
        }
        if (m && "external" in m) return { resolution: "external", reason: `类 ${r.rec.sym.name} 的基类 ${m.external} 不在项目内`, targets: [] };
        return { resolution: "unresolved", reason: `类 ${r.rec.sym.name} 中未找到方法 ${name}`, targets: [] };
      }
    } else if (rootBindings?.length && parts.length > 1) {
      const r = resolveBinding(fi, rootBindings[0]);
      if (r.kind === "external") return { resolution: "external", reason: `${recv} 来自外部模块 ${rootBindings[0].specifier}`, targets: [] };
    }

    if (parts.length === 1) {
      // 同文件类的静态调用 / 对象字面量方法
      const cm = fx.byContainer.get(root)?.get(name)?.[0];
      if (cm && !fx.bindings.has(root)) {
        const cls = (fx.top.get(root) ?? []).find((r) => r.sym.kind === "class");
        const label = cls ? `类 ${root}` : `对象 ${root}`;
        return { resolution: "exact", reason: `同文件${label}的成员 ${name}`, targets: [target(cm, "exact", `${root}.${name}`)] };
      }
      // 局部变量类型推断
      const h = findHint(fi, owner, root);
      if (h) {
        const t = resolveTypeName(fi, h.typeName);
        if (t === "external") return { resolution: "external", reason: `变量 ${root} 的类型 ${h.typeName} 来自外部模块`, targets: [] };
        if (t) {
          const m = lookupMethod(t.rec, name);
          if (m && "rec" in m) {
            const lvl = minLevel("inferred", t.level, m.level);
            return {
              resolution: lvl,
              reason: `变量 ${root} 的类型由${h.source === "annotation" ? "类型标注" : "构造调用"}推断为 ${h.typeName}`,
              targets: [target(m.rec, lvl, `${h.typeName}.${name}（推断）`)],
            };
          }
          if (m && "external" in m) return { resolution: "external", reason: `变量 ${root}（${h.typeName}）的基类 ${m.external} 不在项目内`, targets: [] };
        }
      }
    }
    if (!rootBindings && plugin.globalObjects.has(root)) {
      return { resolution: "external", reason: `${root} 是语言/运行时全局对象或标准库`, targets: [] };
    }
    return heuristicByMethod(fi, owner, call, `无法确定 ${recv} 的类型`);
  };

  const refs: ResolvedRef[] = [];
  for (const f of files) {
    for (const call of f.extract.calls) {
      let o = resolveCall(f.idx, call);
      if ((f.language === "java" || f.language === "csharp") && o.targets.length === 1 && o.resolution !== "heuristic") {
        const picked = recById.get(o.targets[0].symbolId);
        if (picked?.sym.kind === "method") {
          const overloads = (picked.sym.container === null ? recs[picked.fileIdx] : infos[picked.fileIdx].byContainer.get(picked.sym.container)?.get(picked.sym.name) ?? [])
            .filter((r) => r.sym.name === picked.sym.name && r.sym.container === picked.sym.container && r.sym.kind === "method");
          if (overloads.length > 1) o = { resolution: "heuristic", reason: `存在多个同名重载；尚未进行 ${f.language === "java" ? "Java" : "C#"} 参数类型与泛型推导，以下均为候选`, targets: overloads.map((r) => target(r, "heuristic", r.sym.signature)) };
          else if (call.kind !== "new") o = { ...o, resolution: "inferred", targets: o.targets.map((t) => ({ ...t, confidence: "inferred", score: 0.75 })) };
        }
      }
      if (f.language === "vue" && call.origin && o.targets.length && ["exact", "inferred"].includes(o.resolution)) {
        o = { ...o, resolution: "inferred", reason: `${call.origin === "vue-template" ? "Vue 模板静态绑定（不表示初始化执行顺序）" : "按 Vue Options API 的 this 上下文推断"}；${o.reason}`, targets: o.targets.map((t) => ({ ...t, confidence: "inferred", score: 0.75 })) };
      }
      refs.push({
        ownerSymbolId: symbolIds[f.idx][call.ownerLocalId],
        fileIdx: f.idx,
        call,
        resolution: o.resolution,
        reason: o.reason,
        targets: o.targets,
      });
    }
  }

  // 文件级导入概况（含不可解析项）
  const imports: ImportInfo[][] = files.map((f) => {
    const groups = new Map<string, ImportInfo>();
    for (const b of f.extract.imports) {
      const key = `${b.specifier}|${b.line}`;
      let g = groups.get(key);
      if (!g) {
        g = { specifier: b.specifier || ".", names: [], line: b.line, kind: "external", resolvedPath: null, guess: false, reason: null };
        groups.set(key, g);
      }
      g.names.push(b.imported === "*wildcard" ? "*" : b.imported === "*" ? b.local : b.local === b.imported ? b.local : `${b.imported} as ${b.local}`);
      if (b.imported === "*wildcard") {
        const mr = f.plugin.resolveImport(f.path, b.specifier, index);
        if (mr.kind === "project") {
          g.kind = "project";
          g.resolvedPath = mr.path;
          g.guess = mr.guess;
        } else if (mr.kind === "unresolved") {
          g.kind = "unresolved";
          g.reason = mr.reason;
        }
        continue;
      }
      const r = resolveBinding(f.idx, b);
      if (r.kind === "symbol") {
        g.kind = "project";
        g.resolvedPath = pathOf(r.rec);
        g.guess = r.level !== "exact";
      } else if (r.kind === "module") {
        g.kind = "project";
        g.resolvedPath = files[r.fileIdx].path;
        g.guess = r.level !== "exact";
      } else if (r.kind === "unresolved") {
        if (g.kind !== "project") {
          g.kind = "unresolved";
          g.reason = r.reason;
        }
      }
    }
    return [...groups.values()];
  });

  return { refs, imports };
}
