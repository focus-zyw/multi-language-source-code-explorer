import type {
  ExtractResult,
  ExtractedSymbol,
  FileIndex,
  ImportBinding,
  ImportResolution,
  IRStmt,
  LanguagePlugin,
  ParamInfo,
  ReceiverKind,
  SyntaxNode,
  VariableInfo,
  VariableKind,
} from "../types.ts";
import {
  VarCollector,
  collectCallNames,
  computeMetrics,
  hasAncestor,
  inFieldOf,
  oneLine,
  rangeOf,
  slice,
  typeNameFromAnnotation,
  walk,
  type MetricConfig,
} from "../util.ts";

const BUILTIN_FUNCTIONS = new Set(
  (
    "print len range enumerate zip map filter sorted reversed sum min max abs any all isinstance issubclass hasattr getattr setattr delattr " +
    "int float str bool list dict set tuple frozenset bytes bytearray open input type super iter next repr format id hash round divmod pow chr ord " +
    "hex oct bin callable vars dir globals locals property staticmethod classmethod object slice complex memoryview ascii exec eval compile " +
    "Exception BaseException ValueError TypeError KeyError IndexError RuntimeError AttributeError NotImplementedError StopIteration OSError IOError " +
    "FileNotFoundError ImportError AssertionError ZeroDivisionError PermissionError TimeoutError KeyboardInterrupt SystemExit LookupError " +
    "ArithmeticError UnicodeError OverflowError NameError SyntaxError RecursionError"
  ).split(" "),
);

const BUILTIN_METHODS = new Set(
  (
    "append extend insert remove pop clear copy sort reverse index count get items keys values update setdefault add discard union " +
    "intersection difference join split rsplit strip lstrip rstrip format lower upper title capitalize replace startswith endswith find " +
    "encode decode read readline readlines write writelines close flush seek tell isdigit isalpha"
  ).split(" "),
);

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const metricCfg: MetricConfig = {
  isBranch: (n) => ["if_statement", "elif_clause", "case_clause", "conditional_expression", "if_clause"].includes(n.type),
  isLoop: (n) => ["for_statement", "while_statement", "for_in_clause"].includes(n.type),
  isHandler: (n) => n.type === "except_clause" || n.type === "except_group_clause",
  isReturn: (n) => n.type === "return_statement",
  isThrow: (n) => n.type === "raise_statement",
  isAwait: (n) => n.type === "await",
  isBoolOp: (n) => n.type === "boolean_operator",
  isYield: (n) => n.type === "yield",
  isNestedDef: (n) => n.type === "function_definition" || n.type === "class_definition",
};

function isNestedDef(n: SyntaxNode) {
  return n.type === "function_definition" || n.type === "class_definition";
}

function testFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return /^test_.*\.py$/.test(base) || /_tests?\.py$/.test(base) || base === "conftest.py" || /(^|\/)(tests?|testing)\//.test(path);
}

function dottedText(n: SyntaxNode | null, source: string): string | null {
  if (!n) return null;
  if (n.type === "identifier") return slice(source, n);
  if (n.type === "attribute") {
    const o = dottedText(n.childForFieldName("object"), source);
    const a = n.childForFieldName("attribute");
    return o && a ? `${o}.${slice(source, a)}` : null;
  }
  return null;
}

function paramFromNode(p: SyntaxNode, source: string): { info: ParamInfo; nameNode: SyntaxNode } | null {
  const t = (n: SyntaxNode) => slice(source, n);
  switch (p.type) {
    case "identifier":
      return { info: { name: t(p), display: t(p), type: null, defaultValue: null }, nameNode: p };
    case "default_parameter": {
      const n = p.childForFieldName("name");
      const v = p.childForFieldName("value");
      if (!n) return null;
      return {
        info: { name: t(n), display: oneLine(t(p), 60), type: null, defaultValue: v ? oneLine(t(v), 40) : null },
        nameNode: n,
      };
    }
    case "typed_parameter": {
      const inner = p.namedChildren[0];
      const ty = p.childForFieldName("type");
      if (!inner) return null;
      const idNode = inner.type === "identifier" ? inner : (inner.namedChildren[0] ?? inner);
      return {
        info: { name: t(idNode), display: oneLine(t(p), 60), type: ty ? oneLine(t(ty), 40) : null, defaultValue: null },
        nameNode: idNode,
      };
    }
    case "typed_default_parameter": {
      const n = p.childForFieldName("name");
      const ty = p.childForFieldName("type");
      const v = p.childForFieldName("value");
      if (!n) return null;
      return {
        info: {
          name: t(n),
          display: oneLine(t(p), 60),
          type: ty ? oneLine(t(ty), 40) : null,
          defaultValue: v ? oneLine(t(v), 40) : null,
        },
        nameNode: n,
      };
    }
    case "list_splat_pattern":
    case "dictionary_splat_pattern": {
      const id = p.namedChildren[0];
      if (!id) return null;
      return { info: { name: t(id), display: t(p), type: null, defaultValue: null }, nameNode: id };
    }
    default:
      return null;
  }
}

function docstringOf(body: SyntaxNode, source: string): string | null {
  const first = body.namedChildren.find((c) => c.type !== "comment");
  if (!first || first.type !== "expression_statement" || first.namedChildCount !== 1) return null;
  const s = first.namedChildren[0];
  if (!s || s.type !== "string") return null;
  const txt = s.namedChildren
    .filter((c) => c.type === "string_content")
    .map((c) => slice(source, c))
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
  return txt || null;
}

interface Ctx {
  owner: number | null;
  scope: number | null;
  classId: number | null;
  inClass: boolean;
  prefix: string;
  className: string | null;
}

function extract(root: SyntaxNode, source: string, filePath: string): ExtractResult {
  const isTestFile = testFile(filePath);
  const res: ExtractResult = {
    symbols: [],
    calls: [],
    imports: [],
    hints: [],
    defaultExportName: null,
    hasSyntaxErrors: root.hasError,
  };
  const t = (n: SyntaxNode) => slice(source, n);
  const classIsTestCase = new Map<number, boolean>();

  const handleDef = (def: SyntaxNode, outer: SyntaxNode, decorators: string[], ctx: Ctx) => {
    const nameNode = def.childForFieldName("name");
    const body = def.childForFieldName("body");
    if (!nameNode || !body) {
      for (const c of def.namedChildren) visit(c, ctx);
      return;
    }
    const name = t(nameNode);
    const qualifiedName = ctx.prefix ? `${ctx.prefix}.${name}` : name;
    const r = rangeOf(outer);
    const signature = oneLine(source.slice(def.startIndex, body.startIndex).replace(/:\s*$/, ""), 200);
    const localId = res.symbols.length;

    if (def.type === "class_definition") {
      const sup = def.childForFieldName("superclasses");
      const bases = sup
        ? sup.namedChildren.filter((c) => c.type !== "keyword_argument" && c.type !== "comment").map((c) => oneLine(t(c), 60))
        : [];
      classIsTestCase.set(localId, bases.some((b) => /(^|\.)TestCase$/.test(b) || /^unittest\./.test(b)));
      const { metrics } = computeMetrics(def, metricCfg, 0);
      res.symbols.push({
        localId,
        parentLocalId: ctx.scope,
        classLocalId: ctx.classId,
        kind: "class",
        name,
        qualifiedName,
        container: ctx.inClass ? ctx.className : null,
        isAsync: false,
        isGenerator: false,
        isTest: false,
        isDefaultExport: false,
        signature,
        params: [],
        decorators,
        docstring: docstringOf(body, source),
        returnType: null,
        bases,
        ...r,
        defStartIndex: def.startIndex,
        defEndIndex: def.endIndex,
        metrics,
      });
      const cctx: Ctx = { owner: null, scope: localId, classId: localId, inClass: true, prefix: qualifiedName, className: name };
      for (const c of body.namedChildren) visit(c, cctx);
      return;
    }

    const paramsNode = def.childForFieldName("parameters");
    const params: ParamInfo[] = [];
    const paramNodes: { info: ParamInfo; nameNode: SyntaxNode }[] = [];
    if (paramsNode) {
      for (const p of paramsNode.namedChildren) {
        const pr = paramFromNode(p, source);
        if (pr) {
          params.push(pr.info);
          paramNodes.push(pr);
        }
      }
    }
    const isMethod = ctx.inClass;
    const parentIsFunction = !isMethod && ctx.owner !== null;
    const classOk = ctx.classId !== null ? classIsTestCase.get(ctx.classId) ?? false : false;
    const isTest =
      !parentIsFunction &&
      /^test/.test(name) &&
      (isMethod ? classOk || (isTestFile && /^Test/.test(ctx.className ?? "")) : isTestFile);
    const isAsync = def.children.some((c) => c.type === "async");
    const { metrics, isGenerator } = computeMetrics(def, metricCfg, params.length);
    const rt = def.childForFieldName("return_type");
    res.symbols.push({
      localId,
      parentLocalId: ctx.scope,
      classLocalId: ctx.classId,
      kind: isTest ? "test" : isMethod ? "method" : "function",
      name,
      qualifiedName,
      container: isMethod ? ctx.className : null,
      isAsync,
      isGenerator,
      isTest,
      isDefaultExport: false,
      signature,
      params,
      decorators,
      docstring: docstringOf(body, source),
      returnType: rt ? oneLine(t(rt), 60) : null,
      bases: [],
      ...r,
      defStartIndex: def.startIndex,
      defEndIndex: def.endIndex,
      metrics,
    });
    for (const p of params) {
      const typeName = typeNameFromAnnotation(p.type);
      if (typeName) {
        res.hints.push({ ownerLocalId: localId, classLocalId: null, variable: p.name, typeName, source: "annotation", field: false });
      }
    }
    const fctx: Ctx = { owner: localId, scope: localId, classId: ctx.classId, inClass: false, prefix: qualifiedName, className: null };
    for (const c of body.namedChildren) visit(c, fctx);
  };

  const handleCall = (node: SyntaxNode, ctx: Ctx) => {
    if (ctx.owner === null) return;
    const fn = node.childForFieldName("function");
    if (!fn) return;
    let name: string | null = null;
    let receiver: string | null = null;
    let receiverKind: ReceiverKind | null = null;
    let nameNode: SyntaxNode = fn;
    if (fn.type === "identifier") {
      name = t(fn);
    } else if (fn.type === "attribute") {
      const obj = fn.childForFieldName("object");
      const attr = fn.childForFieldName("attribute");
      if (obj && attr) {
        name = t(attr);
        nameNode = attr;
        const dotted = dottedText(obj, source);
        if (dotted) {
          receiver = dotted;
          receiverKind = dotted === "self" || dotted === "cls" ? "self" : "name";
        } else if (obj.type === "call" && obj.childForFieldName("function") && t(obj.childForFieldName("function")!) === "super") {
          receiver = "super()";
          receiverKind = "super";
        } else {
          receiver = oneLine(t(obj), 40);
          receiverKind = "expr";
        }
      }
    }
    res.calls.push({
      ownerLocalId: ctx.owner,
      kind: "call",
      name,
      receiver,
      receiverKind,
      calleeText: oneLine(t(fn), 60),
      line: nameNode.startPosition.row + 1,
      col: nameNode.startPosition.column + 1,
      endLine: nameNode.endPosition.row + 1,
      endCol: nameNode.endPosition.column + 1,
    });
  };

  const handleAssignment = (node: SyntaxNode, ctx: Ctx) => {
    if (ctx.owner === null) return;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const ann = node.childForFieldName("type");
    if (!left) return;
    let variable: string | null = null;
    let field = false;
    if (left.type === "identifier") variable = t(left);
    else if (left.type === "attribute") {
      const obj = left.childForFieldName("object");
      const attr = left.childForFieldName("attribute");
      if (obj && attr && obj.type === "identifier" && ["self", "cls"].includes(t(obj))) {
        variable = t(attr);
        field = true;
      }
    }
    if (!variable) return;
    const base = { ownerLocalId: field ? null : ctx.owner, classLocalId: field ? ctx.classId : null, variable, field };
    const annName = typeNameFromAnnotation(ann ? t(ann) : null);
    if (annName) res.hints.push({ ...base, typeName: annName, source: "annotation" });
    if (right && right.type === "identifier") {
      // self.repo = repo：沿用参数 repo 的类型标注
      const h = res.hints.find((x) => x.ownerLocalId === ctx.owner && x.variable === t(right) && !x.field);
      if (h) res.hints.push({ ...base, typeName: h.typeName, source: h.source });
    }
    if (right && right.type === "call") {
      const fn = right.childForFieldName("function");
      if (fn?.type === "identifier") {
        res.hints.push({ ...base, typeName: t(fn), source: "constructor" });
      } else if (fn?.type === "attribute") {
        const a = fn.childForFieldName("attribute");
        if (a && /^[A-Z]/.test(t(a))) res.hints.push({ ...base, typeName: t(a), source: "constructor" });
      }
    }
  };

  const handleImport = (node: SyntaxNode) => {
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") {
      for (const n of node.childrenForFieldName("name")) {
        if (n.type === "aliased_import") {
          const nm = n.childForFieldName("name");
          const al = n.childForFieldName("alias");
          if (nm && al) res.imports.push({ local: t(al), localPath: t(al), specifier: t(nm), imported: "*", reexport: false, line });
        } else if (n.type === "dotted_name") {
          const full = t(n);
          res.imports.push({ local: full.split(".")[0], localPath: full, specifier: full, imported: "*", reexport: false, line });
        }
      }
      return;
    }
    const mod = node.childForFieldName("module_name");
    const spec = mod ? t(mod).replace(/\s+/g, "") : "";
    const names = node.childrenForFieldName("name");
    if (node.children.some((c) => c.type === "wildcard_import")) {
      res.imports.push({ local: "*", localPath: "*", specifier: spec, imported: "*wildcard", reexport: false, line });
    }
    for (const n of names) {
      let imported: string;
      let local: string;
      if (n.type === "aliased_import") {
        const nm = n.childForFieldName("name");
        const al = n.childForFieldName("alias");
        if (!nm) continue;
        imported = t(nm);
        local = al ? t(al) : imported;
      } else {
        imported = t(n);
        local = imported;
      }
      const b: ImportBinding = { local, localPath: local, specifier: spec, imported, reexport: false, line };
      res.imports.push(b);
    }
  };

  const visit = (node: SyntaxNode, ctx: Ctx): void => {
    switch (node.type) {
      case "decorated_definition": {
        const def = node.childForFieldName("definition");
        if (def) {
          const decorators = node.namedChildren.filter((c) => c.type === "decorator").map((d) => oneLine(t(d), 80));
          handleDef(def, node, decorators, ctx);
          return;
        }
        break;
      }
      case "function_definition":
      case "class_definition":
        handleDef(node, node, [], ctx);
        return;
      case "call":
        handleCall(node, ctx);
        break;
      case "assignment":
        handleAssignment(node, ctx);
        break;
      case "import_statement":
      case "import_from_statement":
        handleImport(node);
        return;
    }
    for (const c of node.namedChildren) visit(c, ctx);
  };

  visit(root, { owner: null, scope: null, classId: null, inClass: false, prefix: "", className: null });
  return res;
}

/* ---------------- 流程图 IR ---------------- */

function flowIR(def: SyntaxNode, source: string): IRStmt[] {
  const t = (n: SyntaxNode | null) => (n ? slice(source, n) : "");
  const callsOf = (...nodes: (SyntaxNode | null)[]) => collectCallNames(nodes, source, { call: "function" }, isNestedDef);
  const lines = (n: SyntaxNode) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });
  const header = (n: SyntaxNode, body: SyntaxNode | null) =>
    oneLine(source.slice(n.startIndex, body ? body.startIndex : n.endIndex).replace(/:\s*$/, ""), 70);
  const blockOf = (n: SyntaxNode) => n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "block") ?? null;

  const blockIR = (block: SyntaxNode | null): IRStmt[] => {
    if (!block) return [];
    const out: IRStmt[] = [];
    for (const c of block.namedChildren) out.push(...stmtIR(c));
    return out;
  };

  const elseChain = (alts: SyntaxNode[]): IRStmt[] => {
    if (!alts.length) return [];
    const first = alts[0];
    if (first.type === "elif_clause") {
      const cond = first.childForFieldName("condition");
      return [
        {
          t: "if",
          ...lines(first),
          cond: oneLine(t(cond), 70),
          calls: callsOf(cond),
          then: blockIR(first.childForFieldName("consequence")),
          else: elseChain(alts.slice(1)),
        },
      ];
    }
    return blockIR(blockOf(first));
  };

  const stmtIR = (n: SyntaxNode): IRStmt[] => {
    const r = lines(n);
    switch (n.type) {
      case "comment":
      case "pass_statement":
        return [];
      case "if_statement": {
        const cond = n.childForFieldName("condition");
        return [
          {
            t: "if",
            ...r,
            cond: oneLine(t(cond), 70),
            calls: callsOf(cond),
            then: blockIR(n.childForFieldName("consequence")),
            else: elseChain(n.childrenForFieldName("alternative")),
          },
        ];
      }
      case "for_statement":
      case "while_statement": {
        const isFor = n.type === "for_statement";
        const alt = n.childForFieldName("alternative");
        const cond = isFor ? n.childForFieldName("right") : n.childForFieldName("condition");
        return [
          {
            t: "loop",
            kind: isFor ? "for" : "while",
            ...r,
            cond: isFor ? oneLine(`for ${t(n.childForFieldName("left"))} in ${t(cond)}`, 70) : oneLine(`while ${t(cond)}`, 70),
            calls: callsOf(cond),
            body: blockIR(n.childForFieldName("body")),
            orElse: alt ? blockIR(blockOf(alt)) : [],
          },
        ];
      }
      case "try_statement": {
        const handlers: { label: string; startLine: number; endLine: number; body: IRStmt[] }[] = [];
        let orElse: IRStmt[] = [];
        let fin: IRStmt[] = [];
        for (const c of n.namedChildren) {
          if (c.type === "except_clause" || c.type === "except_group_clause") {
            const b = c.namedChildren.find((x) => x.type === "block") ?? null;
            handlers.push({ label: header(c, b), ...lines(c), body: blockIR(b) });
          } else if (c.type === "else_clause") orElse = blockIR(blockOf(c));
          else if (c.type === "finally_clause") fin = blockIR(c.namedChildren.find((x) => x.type === "block") ?? null);
        }
        return [{ t: "try", ...r, body: blockIR(n.childForFieldName("body")), handlers, orElse, finally: fin }];
      }
      case "with_statement": {
        const body = n.childForFieldName("body");
        const head: IRStmt = { t: "stmt", ...lines(n), startLine: r.startLine, endLine: body ? body.startPosition.row : r.startLine, label: header(n, body), calls: callsOf(...n.namedChildren.filter((c) => c.type === "with_clause")) };
        return [head, ...blockIR(body)];
      }
      case "match_statement": {
        const body = n.childForFieldName("body");
        const cases = (body ? body.namedChildren : [])
          .filter((c) => c.type === "case_clause")
          .map((c) => {
            const cons = c.childForFieldName("consequence");
            const label = header(c, cons);
            return { label, ...lines(c), body: blockIR(cons), isDefault: /^case\s+_\s*(:|if\b|$)/.test(label) };
          });
        const subj = n.childForFieldName("subject");
        return [{ t: "switch", ...r, disc: oneLine(t(subj), 60), calls: callsOf(subj), fallthrough: false, cases }];
      }
      case "return_statement":
        return [{ t: "return", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
      case "raise_statement":
        return [{ t: "throw", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
      case "break_statement":
        return [{ t: "break", ...r }];
      case "continue_statement":
        return [{ t: "continue", ...r }];
      case "function_definition":
      case "class_definition":
      case "decorated_definition": {
        const d = n.type === "decorated_definition" ? n.childForFieldName("definition") : n;
        const nm = d?.childForFieldName("name");
        return [{ t: "stmt", ...r, label: `${d?.type === "class_definition" ? "class" : "def"} ${t(nm ?? null)}（嵌套定义）`, calls: [] }];
      }
      case "expression_statement": {
        if (n.namedChildCount === 1 && n.namedChildren[0].type === "string") return [];
        return [{ t: "stmt", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
      }
      default:
        return [{ t: "stmt", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
    }
  };

  return blockIR(def.childForFieldName("body"));
}

/* ---------------- 变量分析 ---------------- */

const PATTERN_WRAPPERS = new Set(["pattern_list", "tuple_pattern", "list_pattern", "tuple", "list", "list_splat_pattern", "parenthesized_expression"]);

function writeContext(n: SyntaxNode): { kind: VariableKind; stmt: SyntaxNode; annotation: SyntaxNode | null } | null {
  let cur = n;
  while (cur.parent && PATTERN_WRAPPERS.has(cur.parent.type)) cur = cur.parent;
  const p = cur.parent;
  if (!p) return null;
  const isField = (f: string) => p.childForFieldName(f)?.id === cur.id;
  switch (p.type) {
    case "assignment":
      return isField("left") ? { kind: "local", stmt: p, annotation: p.childForFieldName("type") } : null;
    case "augmented_assignment":
      return isField("left") ? { kind: "local", stmt: p, annotation: null } : null;
    case "for_statement":
    case "for_in_clause":
      return isField("left") ? { kind: "loop", stmt: p, annotation: null } : null;
    case "named_expression":
      return isField("name") ? { kind: "local", stmt: p, annotation: null } : null;
    case "as_pattern_target": {
      const isCatch = hasAncestor(p, (a) => a.type === "except_clause" || a.type === "except_group_clause");
      return { kind: isCatch ? "catch" : "with", stmt: p.parent ?? p, annotation: null };
    }
    default:
      return null;
  }
}

function analyzeVariables(def: SyntaxNode, source: string): VariableInfo[] {
  const t = (n: SyntaxNode) => slice(source, n);
  const vc = new VarCollector();
  const body = def.childForFieldName("body");
  const paramsNode = def.childForFieldName("parameters");
  let firstParam: string | null = null;

  if (paramsNode) {
    for (const p of paramsNode.namedChildren) {
      const pr = paramFromNode(p, source);
      if (!pr) continue;
      if (firstParam === null) firstParam = pr.info.name;
      vc.declare(pr.info.name, pr.nameNode, { kind: "param", typeText: pr.info.type, snippet: oneLine(t(p), 100) });
    }
  }
  if (!body) return vc.build(source);

  // 方法所属类
  let classNode: SyntaxNode | null = null;
  {
    let cur: SyntaxNode | null = def.parent;
    while (cur) {
      if (cur.type === "class_definition") {
        classNode = cur;
        break;
      }
      if (cur.type === "function_definition") break;
      cur = cur.parent;
    }
  }
  const selfNames = new Set(["self", "cls"]);
  if (classNode && firstParam) selfNames.add(firstParam);

  const fieldFirstWrite = new Map<string, SyntaxNode>();
  const fieldNames: string[] = [];

  const tagsFor = (n: SyntaxNode): string[] => {
    const tags: string[] = [];
    if (hasAncestor(n, (a) => a.type === "return_statement", def)) tags.push("returned");
    if (inFieldOf(n, ["if_statement", "elif_clause", "while_statement"], "condition", def)) tags.push("condition");
    if (hasAncestor(n, (a) => a.type === "raise_statement", def)) tags.push("raised");
    return tags;
  };

  walk(body, (n) => {
    if (isNestedDef(n)) return false;
    if (n.type === "attribute") {
      const obj = n.childForFieldName("object");
      const attr = n.childForFieldName("attribute");
      if (obj && attr && obj.type === "identifier" && selfNames.has(t(obj))) {
        const parent = n.parent;
        const isCallee = parent?.type === "call" && parent.childForFieldName("function")?.id === n.id;
        if (!isCallee) {
          const name = `${t(obj)}.${t(attr)}`;
          const wc = writeContext(n);
          const access = wc ? "write" : "read";
          if (!fieldNames.includes(name)) {
            fieldNames.push(name);
            vc.declareField(name);
          }
          if (access === "write" && !fieldFirstWrite.has(name)) fieldFirstWrite.set(name, n);
          vc.occur(name, attr, access, tagsFor(n));
        }
      }
      return true;
    }
    if (n.type !== "identifier") return true;
    const p = n.parent;
    if (!p) return true;
    if (p.type === "attribute" && p.childForFieldName("attribute")?.id === n.id) return true;
    if (p.type === "keyword_argument" && p.childForFieldName("name")?.id === n.id) return true;
    if (["dotted_name", "aliased_import", "import_statement", "import_from_statement", "global_statement", "nonlocal_statement", "lambda_parameters", "relative_import"].includes(p.type)) return true;
    const name = t(n);
    const wc = writeContext(n);
    if (wc) {
      vc.declare(name, n, {
        kind: wc.kind,
        typeText: wc.annotation ? oneLine(t(wc.annotation), 40) : null,
        snippet: oneLine(t(wc.stmt), 100),
      });
    } else {
      vc.occur(name, n, "read", tagsFor(n));
    }
    return true;
  });

  // 字段定义位置
  for (const name of fieldNames) {
    const attrName = name.split(".")[1];
    const w = fieldFirstWrite.get(name);
    const mk = (node: SyntaxNode, stmt: SyntaxNode, where: "method" | "class", suffix = "") => ({
      line: node.startPosition.row + 1,
      col: node.startPosition.column + 1,
      endCol: node.endPosition.column + 1,
      snippet: oneLine(t(stmt), 90) + suffix,
      where,
    });
    if (w) {
      vc.setFieldDefinition(name, mk(w, writeContext(w)?.stmt ?? w, "method"));
      continue;
    }
    if (!classNode) continue;
    let found: { node: SyntaxNode; stmt: SyntaxNode; method: string | null } | null = null;
    walk(classNode, (n) => {
      if (found) return false;
      if (n.type === "attribute") {
        const o = n.childForFieldName("object");
        const a = n.childForFieldName("attribute");
        if (o && a && o.type === "identifier" && selfNames.has(t(o)) && t(a) === attrName) {
          const wc = writeContext(n);
          if (wc && (wc.stmt.type === "assignment" || wc.stmt.type === "augmented_assignment")) {
            let m: SyntaxNode | null = n.parent;
            while (m && m.type !== "function_definition") m = m.parent;
            found = { node: n, stmt: wc.stmt, method: m?.childForFieldName("name") ? t(m.childForFieldName("name")!) : null };
            return false;
          }
        }
      }
      return true;
    });
    const f = found as { node: SyntaxNode; stmt: SyntaxNode; method: string | null } | null;
    if (f) {
      vc.setFieldDefinition(name, mk(f.node, f.stmt, "class", f.method ? `   // 于 ${f.method}()` : ""));
      continue;
    }
    // 类级别变量
    const cbody = classNode.childForFieldName("body");
    const classVar = cbody?.namedChildren.find((c) => {
      if (c.type !== "expression_statement") return false;
      const a = c.namedChildren[0];
      return a?.type === "assignment" && a.childForFieldName("left")?.type === "identifier" && t(a.childForFieldName("left")!) === attrName;
    });
    if (classVar) vc.setFieldDefinition(name, mk(classVar, classVar, "class", "   // 类属性"));
  }
  return vc.build(source);
}

/* ---------------- 导入解析 ---------------- */

function resolveImport(fromPath: string, spec: string, index: FileIndex): ImportResolution {
  const m = /^(\.*)(.*)$/.exec(spec)!;
  const level = m[1].length;
  const parts = m[2] ? m[2].split(".").filter(Boolean) : [];
  const probe = (base: string): string | null => {
    const joined = [base, ...parts].filter(Boolean).join("/");
    const cands = parts.length ? [`${joined}.py`, `${joined}/__init__.py`] : [`${[base, "__init__.py"].filter(Boolean).join("/")}`];
    for (const c of cands) if (index.has(c)) return c;
    return null;
  };
  const fromDir = dirname(fromPath);
  if (level > 0) {
    let base = fromDir;
    for (let i = 1; i < level; i++) base = dirname(base);
    const hit = probe(base);
    return hit ? { kind: "project", path: hit, guess: false } : { kind: "unresolved", reason: `相对导入 ${spec} 未在项目中找到对应模块` };
  }
  if (!parts.length) return { kind: "unresolved", reason: "空的导入说明符" };
  let dir = fromDir;
  for (;;) {
    const hit = probe(dir);
    if (hit) return { kind: "project", path: hit, guess: dir !== "" };
    if (dir === "") break;
    dir = dirname(dir);
  }
  const suffix = parts.join("/");
  const cands = [...index.bySuffix(`/${suffix}.py`), ...index.bySuffix(`/${suffix}/__init__.py`)];
  if (cands.length === 1) return { kind: "project", path: cands[0], guess: true };
  if (cands.length > 1) return { kind: "unresolved", reason: `模块 ${spec} 在项目中匹配到多个文件，无法确定` };
  return { kind: "external" };
}

export const pythonPlugin: LanguagePlugin = {
  id: "python",
  label: "Python",
  extensions: [".py"],
  grammarFor: () => "python",
  isTestFile: testFile,
  extract,
  flowIR,
  analyzeVariables,
  resolveImport,
  joinSubmodule: (spec, name) => (/^\.*$/.test(spec) ? spec + name : `${spec}.${name}`),
  builtinFunctions: BUILTIN_FUNCTIONS,
  globalObjects: new Set(["os", "sys", "re", "json", "math", "random", "time", "datetime", "logging", "typing", "collections", "itertools", "functools", "pathlib", "subprocess", "unittest", "pytest", "asyncio"]),
  builtinMethods: BUILTIN_METHODS,
  constructorNames: ["__init__"],
};

export type { ExtractedSymbol };
