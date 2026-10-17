import type {
  ExtractResult,
  FileIndex,
  ImportResolution,
  IRStmt,
  LanguageId,
  LanguagePlugin,
  ParamInfo,
  ReceiverKind,
  SymbolKind,
  SyntaxNode,
  VariableInfo,
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

const FN_TYPES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "function", "arrow_function"]);
const NESTED_DEF = new Set(["function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration", "method_definition"]);
const SUITE_NAMES = new Set(["describe", "suite", "context", "fdescribe", "xdescribe"]);
const TEST_NAMES = new Set(["it", "test", "specify", "fit", "xit", "xtest"]);
const TEST_MODIFIERS = new Set(["only", "skip", "todo", "concurrent", "failing", "sequential"]);

const BUILTIN_FUNCTIONS = new Set(
  (
    "setTimeout clearTimeout setInterval clearInterval setImmediate parseInt parseFloat isNaN isFinite fetch require " +
    "encodeURIComponent decodeURIComponent encodeURI decodeURI structuredClone queueMicrotask alert confirm prompt atob btoa " +
    "Error TypeError RangeError SyntaxError ReferenceError Promise Symbol Boolean Number String BigInt Date RegExp Map Set WeakMap WeakSet Array Object URL URLSearchParams " +
    "expect describe it test beforeEach afterEach beforeAll afterAll jest vi"
  ).split(" "),
);
const GLOBAL_OBJECTS = new Set(
  "console Math JSON Object Array Promise Number String Boolean Date Symbol Reflect Intl process Buffer document window globalThis localStorage sessionStorage navigator location module exports crypto performance Atomics".split(" "),
);
const BUILTIN_METHODS = new Set(
  (
    "push pop shift unshift map filter forEach reduce reduceRight find findIndex some every includes indexOf lastIndexOf slice splice concat join sort reverse flat flatMap fill keys values entries " +
    "then catch finally toString toFixed toLowerCase toUpperCase trim split replace replaceAll startsWith endsWith substring padStart padEnd match test exec " +
    "get set has delete add clear log warn error info debug on once off emit addEventListener removeEventListener call apply bind assign freeze parse stringify"
  ).split(" "),
);

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const metricCfg: MetricConfig = {
  isBranch: (n) => ["if_statement", "switch_case", "ternary_expression"].includes(n.type),
  isLoop: (n) => ["for_statement", "for_in_statement", "while_statement", "do_statement"].includes(n.type),
  isHandler: (n) => n.type === "catch_clause",
  isReturn: (n) => n.type === "return_statement",
  isThrow: (n) => n.type === "throw_statement",
  isAwait: (n) => n.type === "await_expression",
  isBoolOp: (n) => {
    if (n.type !== "binary_expression") return false;
    const op = n.childForFieldName("operator")?.type;
    return op === "&&" || op === "||" || op === "??";
  },
  isYield: (n) => n.type === "yield_expression",
  isNestedDef: (n) => NESTED_DEF.has(n.type),
};

const isNestedDef = (n: SyntaxNode) => NESTED_DEF.has(n.type);

function testFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(__tests__|tests?|spec)\//.test(path);
}

function dottedText(n: SyntaxNode | null, source: string): string | null {
  if (!n) return null;
  if (n.type === "identifier" || n.type === "this") return slice(source, n);
  if (n.type === "member_expression") {
    const o = dottedText(n.childForFieldName("object"), source);
    const p = n.childForFieldName("property");
    return o && p ? `${o}.${slice(source, p)}` : null;
  }
  return null;
}

function stringValue(n: SyntaxNode | null, source: string): string | null {
  if (!n) return null;
  if (n.type === "string" || n.type === "template_string") return slice(source, n).slice(1, -1);
  return null;
}

function patternIdentifiers(n: SyntaxNode | null, out: SyntaxNode[] = []): SyntaxNode[] {
  if (!n) return out;
  switch (n.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(n);
      break;
    case "pair_pattern":
      patternIdentifiers(n.childForFieldName("value"), out);
      break;
    case "assignment_pattern":
      patternIdentifiers(n.childForFieldName("left"), out);
      break;
    case "object_assignment_pattern":
      patternIdentifiers(n.childForFieldName("left"), out);
      break;
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      for (const c of n.namedChildren) patternIdentifiers(c, out);
      break;
    default:
      break;
  }
  return out;
}

interface ParsedParam {
  info: ParamInfo;
  idNodes: SyntaxNode[];
  propertyField: boolean;
}

function parseParams(fn: SyntaxNode, source: string): ParsedParam[] {
  const t = (n: SyntaxNode) => slice(source, n);
  const out: ParsedParam[] = [];
  const single = fn.childForFieldName("parameter");
  if (single) {
    out.push({ info: { name: t(single), display: t(single), type: null, defaultValue: null }, idNodes: [single], propertyField: false });
    return out;
  }
  const params = fn.childForFieldName("parameters");
  if (!params) return out;
  for (const p of params.namedChildren) {
    if (p.type === "comment") continue;
    let pattern: SyntaxNode | null = p;
    let typeText: string | null = null;
    let def: string | null = null;
    let propertyField = false;
    if (p.type === "required_parameter" || p.type === "optional_parameter") {
      pattern = p.childForFieldName("pattern");
      const ty = p.childForFieldName("type");
      typeText = ty ? oneLine(t(ty).replace(/^:\s*/, ""), 40) : null;
      const v = p.childForFieldName("value");
      def = v ? oneLine(t(v), 40) : null;
      propertyField = p.namedChildren.some((c) => c.type === "accessibility_modifier" || c.type === "readonly");
    } else if (p.type === "assignment_pattern") {
      pattern = p.childForFieldName("left");
      const v = p.childForFieldName("right");
      def = v ? oneLine(t(v), 40) : null;
    }
    if (!pattern) continue;
    const idNodes = patternIdentifiers(pattern);
    const name = pattern.type === "identifier" ? t(pattern) : pattern.type === "rest_pattern" && idNodes[0] ? t(idNodes[0]) : oneLine(t(pattern), 30);
    out.push({
      info: { name, display: oneLine(t(p), 60), type: typeText, defaultValue: def },
      idNodes,
      propertyField,
    });
  }
  return out;
}

function jsdocOf(outer: SyntaxNode, source: string): string | null {
  let anchor: SyntaxNode = outer;
  if (outer.parent?.type === "export_statement") anchor = outer.parent;
  const prev = anchor.previousSibling;
  if (!prev || prev.type !== "comment") return null;
  const txt = slice(source, prev);
  if (!txt.startsWith("/**")) return null;
  if (anchor.startPosition.row - prev.endPosition.row > 1) return null;
  const cleaned = txt
    .replace(/^\/\*\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .join("\n")
    .trim();
  return cleaned || null;
}

interface Ctx {
  owner: number | null;
  scope: number | null;
  classId: number | null;
  className: string | null;
  inClass: boolean;
  prefix: string;
  describe: string[];
}

function extract(root: SyntaxNode, source: string, filePath: string): ExtractResult {
  const isTestFile = testFile(filePath);
  const res: ExtractResult = { symbols: [], calls: [], imports: [], hints: [], defaultExportName: null, hasSyntaxErrors: root.hasError };
  const t = (n: SyntaxNode) => slice(source, n);

  interface AddFn {
    fn: SyntaxNode;
    outer: SyntaxNode;
    name: string;
    kind: SymbolKind;
    container: string | null;
    qualifiedName: string;
    ctx: Ctx;
    isDefault?: boolean;
    signature?: string;
    docFrom?: SyntaxNode | null;
  }

  const addFunction = (o: AddFn): number => {
    const fn = o.fn;
    const body = fn.childForFieldName("body");
    const parsed = parseParams(fn, source);
    const params = parsed.map((p) => p.info);
    const localId = res.symbols.length;
    const { metrics, isGenerator } = computeMetrics(fn, metricCfg, params.length);
    const rt = fn.childForFieldName("return_type");
    const decorators = fn.children.filter((c) => c.type === "decorator").map((d) => oneLine(t(d), 80));
    const signature = o.signature ?? oneLine(source.slice(o.outer.startIndex, body ? body.startIndex : fn.endIndex), 200);
    res.symbols.push({
      localId,
      parentLocalId: o.ctx.scope,
      classLocalId: o.ctx.classId,
      kind: o.kind,
      name: o.name,
      qualifiedName: o.qualifiedName,
      container: o.container,
      isAsync: fn.children.some((c) => c.type === "async"),
      isGenerator: isGenerator || fn.type.includes("generator") || fn.children.some((c) => c.type === "*"),
      isTest: o.kind === "test",
      isDefaultExport: !!o.isDefault,
      signature,
      params,
      decorators,
      docstring: o.kind === "test" ? null : jsdocOf(o.docFrom ?? o.outer, source),
      returnType: rt ? oneLine(t(rt).replace(/^:\s*/, ""), 60) : null,
      bases: [],
      ...rangeOf(o.outer),
      defStartIndex: fn.startIndex,
      defEndIndex: fn.endIndex,
      metrics,
    });
    for (const p of parsed) {
      const typeName = typeNameFromAnnotation(p.info.type);
      if (typeName) {
        res.hints.push({ ownerLocalId: localId, classLocalId: null, variable: p.info.name, typeName, source: "annotation", field: false });
        if (p.propertyField && o.ctx.classId !== null) {
          res.hints.push({ ownerLocalId: null, classLocalId: o.ctx.classId, variable: p.info.name, typeName, source: "annotation", field: true });
        }
      }
    }
    return localId;
  };

  const visitFunctionBody = (fn: SyntaxNode, localId: number, name: string, qualifiedName: string, ctx: Ctx) => {
    const fctx: Ctx = { ...ctx, owner: localId, scope: localId, inClass: false, prefix: qualifiedName, describe: ctx.describe };
    void name;
    for (const c of fn.namedChildren) visit(c, fctx);
  };

  const qn = (ctx: Ctx, name: string) => (ctx.prefix ? `${ctx.prefix}.${name}` : name);

  const unwrapFn = (v: SyntaxNode | null): SyntaxNode | null => {
    if (!v) return null;
    if (FN_TYPES.has(v.type) && v.childForFieldName("body")) return v;
    if (v.type === "parenthesized_expression") return unwrapFn(v.namedChildren[0] ?? null);
    return null;
  };

  const propName = (n: SyntaxNode | null): string | null => {
    if (!n) return null;
    if (n.type === "property_identifier" || n.type === "private_property_identifier" || n.type === "identifier") return t(n);
    if (n.type === "string") return t(n).slice(1, -1);
    return null;
  };

  const handleClass = (node: SyntaxNode, outer: SyntaxNode, ctx: Ctx, isDefault: boolean) => {
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    const name = nameNode ? t(nameNode) : isDefault ? "default" : null;
    if (!name || !body) {
      for (const c of node.namedChildren) visit(c, ctx);
      return;
    }
    const localId = res.symbols.length;
    const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
    const bases: string[] = [];
    if (heritage) {
      for (const c of heritage.namedChildren) {
        if (c.type === "extends_clause") for (const v of c.childrenForFieldName("value")) bases.push(oneLine(t(v), 60));
        else if (c.type !== "implements_clause" && c.type !== "comment") bases.push(oneLine(t(c), 60));
      }
    }
    const { metrics } = computeMetrics(node, metricCfg, 0);
    const qualifiedName = qn(ctx, name);
    res.symbols.push({
      localId,
      parentLocalId: ctx.scope,
      classLocalId: ctx.classId,
      kind: "class",
      name,
      qualifiedName,
      container: null,
      isAsync: false,
      isGenerator: false,
      isTest: false,
      isDefaultExport: isDefault,
      signature: oneLine(source.slice(outer.startIndex, body.startIndex), 200),
      params: [],
      decorators: node.children.filter((c) => c.type === "decorator").map((d) => oneLine(t(d), 80)),
      docstring: jsdocOf(outer, source),
      returnType: null,
      bases,
      ...rangeOf(outer),
      defStartIndex: node.startIndex,
      defEndIndex: node.endIndex,
      metrics,
    });
    const cctx: Ctx = { owner: null, scope: localId, classId: localId, className: name, inClass: true, prefix: qualifiedName, describe: [] };
    for (const m of body.namedChildren) {
      if (m.type === "method_definition") {
        visit(m, cctx);
      } else if (m.type === "public_field_definition" || m.type === "field_definition") {
        const nm = propName(m.childForFieldName("name") ?? m.childForFieldName("property"));
        const value = m.childForFieldName("value");
        const fn = unwrapFn(value);
        const ann = typeNameFromAnnotation(m.childForFieldName("type") ? t(m.childForFieldName("type")!) : null);
        if (nm && ann) res.hints.push({ ownerLocalId: null, classLocalId: localId, variable: nm, typeName: ann, source: "annotation", field: true });
        if (nm && value?.type === "new_expression") {
          const c = value.childForFieldName("constructor");
          if (c?.type === "identifier") res.hints.push({ ownerLocalId: null, classLocalId: localId, variable: nm, typeName: t(c), source: "constructor", field: true });
        }
        if (nm && fn) {
          const q = qn(cctx, nm);
          const id = addFunction({ fn, outer: m, name: nm, kind: "method", container: name, qualifiedName: q, ctx: cctx });
          visitFunctionBody(fn, id, nm, q, cctx);
        } else if (value) {
          visit(value, { ...cctx, owner: null });
        }
      } else {
        visit(m, cctx);
      }
    }
  };

  const visitObject = (obj: SyntaxNode, container: string | null, kind: SymbolKind, ctx: Ctx, outerForDoc: SyntaxNode | null) => {
    for (const c of obj.namedChildren) {
      if (c.type === "method_definition") {
        const nm = propName(c.childForFieldName("name"));
        if (!nm) continue;
        const q = qn(ctx, nm);
        const id = addFunction({ fn: c, outer: c, name: nm, kind, container, qualifiedName: container ? `${container}.${nm}` : q, ctx });
        visitFunctionBody(c, id, nm, container ? `${container}.${nm}` : q, ctx);
      } else if (c.type === "pair") {
        const nm = propName(c.childForFieldName("key"));
        const fn = unwrapFn(c.childForFieldName("value"));
        if (nm && fn) {
          const id = addFunction({ fn, outer: c, name: nm, kind, container, qualifiedName: container ? `${container}.${nm}` : qn(ctx, nm), ctx });
          visitFunctionBody(fn, id, nm, container ? `${container}.${nm}` : qn(ctx, nm), ctx);
        } else {
          visit(c, ctx);
        }
      } else {
        visit(c, ctx);
      }
    }
    void outerForDoc;
  };

  const requireInfo = (v: SyntaxNode | null): { spec: string; member: string | null } | null => {
    if (!v) return null;
    let call = v;
    let member: string | null = null;
    if (v.type === "member_expression") {
      const o = v.childForFieldName("object");
      const p = v.childForFieldName("property");
      if (o?.type === "call_expression" && p) {
        call = o;
        member = t(p);
      }
    }
    if (call.type !== "call_expression") return null;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "identifier" || t(fn) !== "require") return null;
    const arg = call.childForFieldName("arguments")?.namedChildren[0] ?? null;
    const spec = stringValue(arg, source);
    return spec ? { spec, member } : null;
  };

  const handleDeclarator = (node: SyntaxNode, ctx: Ctx): boolean => {
    const nameNode = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (!nameNode) return false;
    const line = node.startPosition.row + 1;
    const req = requireInfo(value);
    if (req) {
      if (nameNode.type === "identifier") {
        res.imports.push({ local: t(nameNode), localPath: t(nameNode), specifier: req.spec, imported: req.member ?? "*", reexport: false, line });
      } else if (nameNode.type === "object_pattern") {
        for (const c of nameNode.namedChildren) {
          if (c.type === "shorthand_property_identifier_pattern") {
            res.imports.push({ local: t(c), localPath: t(c), specifier: req.spec, imported: t(c), reexport: false, line });
          } else if (c.type === "pair_pattern") {
            const k = c.childForFieldName("key");
            const v = c.childForFieldName("value");
            if (k && v?.type === "identifier") res.imports.push({ local: t(v), localPath: t(v), specifier: req.spec, imported: t(k), reexport: false, line });
          }
        }
      }
      return true;
    }
    if (nameNode.type !== "identifier") return false;
    const name = t(nameNode);
    const fn = unwrapFn(value);
    if (fn) {
      const decl = node.parent;
      let outer: SyntaxNode = decl && (decl.type === "lexical_declaration" || decl.type === "variable_declaration") ? decl : node;
      if (outer.parent?.type === "export_statement") outer = outer.parent;
      const q = qn(ctx, name);
      const id = addFunction({ fn, outer, name, kind: "function", container: null, qualifiedName: q, ctx });
      visitFunctionBody(fn, id, name, q, ctx);
      return true;
    }
    const ann = typeNameFromAnnotation(node.childForFieldName("type") ? t(node.childForFieldName("type")!) : null);
    if (ctx.owner !== null) {
      if (ann) res.hints.push({ ownerLocalId: ctx.owner, classLocalId: null, variable: name, typeName: ann, source: "annotation", field: false });
      if (value?.type === "new_expression") {
        const c = value.childForFieldName("constructor");
        if (c?.type === "identifier") res.hints.push({ ownerLocalId: ctx.owner, classLocalId: null, variable: name, typeName: t(c), source: "constructor", field: false });
      }
    }
    if (value?.type === "object") {
      visitObject(value, name, "method", ctx, node);
      return true;
    }
    return false;
  };

  const handleAssignment = (node: SyntaxNode, ctx: Ctx): boolean => {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) return false;
    if (left.type !== "member_expression") return false;
    const chain = dottedText(left, source);
    const prop = left.childForFieldName("property");
    const fn = unwrapFn(right);
    const objText = dottedText(left.childForFieldName("object"), source);
    if (objText === "this" && prop && ctx.owner !== null) {
      const field = t(prop);
      if (right.type === "new_expression") {
        const c = right.childForFieldName("constructor");
        if (c?.type === "identifier") res.hints.push({ ownerLocalId: null, classLocalId: ctx.classId, variable: field, typeName: t(c), source: "constructor", field: true });
      } else if (right.type === "identifier") {
        const h = res.hints.find((x) => x.ownerLocalId === ctx.owner && x.variable === t(right) && !x.field);
        if (h) res.hints.push({ ownerLocalId: null, classLocalId: ctx.classId, variable: field, typeName: h.typeName, source: h.source, field: true });
      }
      return false;
    }
    if (!fn || !chain || !prop) return false;
    const name = t(prop);
    let container: string | null = null;
    let kind: SymbolKind = "function";
    const proto = /^([A-Za-z_$][\w$]*)\.prototype\.[\w$]+$/.exec(chain);
    if (/^(module\.)?exports\.[\w$]+$/.test(chain)) {
      container = null;
    } else if (proto) {
      container = proto[1];
      kind = "method";
    } else if (/^[A-Z][\w$]*\.[\w$]+$/.test(chain)) {
      container = chain.split(".")[0];
      kind = "method";
    } else return false;
    const outer = node.parent?.type === "expression_statement" ? node.parent : node;
    const q = container ? `${container}.${name}` : qn(ctx, name);
    const id = addFunction({ fn, outer, name, kind, container, qualifiedName: q, ctx });
    visitFunctionBody(fn, id, name, q, ctx);
    return true;
  };

  const testCallInfo = (node: SyntaxNode): { type: "suite" | "test"; callee: string } | null => {
    const fn = node.childForFieldName("function");
    if (!fn) return null;
    const classify = (name: string): "suite" | "test" | null => (SUITE_NAMES.has(name) ? "suite" : TEST_NAMES.has(name) ? "test" : null);
    if (fn.type === "identifier") {
      const c = classify(t(fn));
      return c ? { type: c, callee: t(fn) } : null;
    }
    if (fn.type === "member_expression") {
      const o = fn.childForFieldName("object");
      const p = fn.childForFieldName("property");
      if (o?.type === "identifier" && p && TEST_MODIFIERS.has(t(p))) {
        const c = classify(t(o));
        return c ? { type: c, callee: `${t(o)}.${t(p)}` } : null;
      }
    }
    if (fn.type === "call_expression") {
      const inner = fn.childForFieldName("function");
      if (inner?.type === "member_expression") {
        const o = inner.childForFieldName("object");
        const p = inner.childForFieldName("property");
        if (o?.type === "identifier" && p && t(p) === "each") {
          const c = classify(t(o));
          return c ? { type: c, callee: `${t(o)}.each` } : null;
        }
      }
    }
    return null;
  };

  const handleTestCall = (node: SyntaxNode, ctx: Ctx): boolean => {
    const info = testCallInfo(node);
    if (!info) return false;
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];
    const title = stringValue(args[0] ?? null, source);
    if (title === null) return false;
    const cb = args.slice(1).map(unwrapFn).find((x) => x);
    if (!cb) return false;
    if (info.type === "suite") {
      const sctx: Ctx = { ...ctx, describe: [...ctx.describe, title] };
      for (const c of cb.namedChildren) visit(c, sctx);
      return true;
    }
    const outer = node.parent?.type === "expression_statement" ? node.parent : node;
    const container = ctx.describe.length ? ctx.describe.join(" › ") : null;
    const q = [...ctx.describe, title].join(" › ");
    const id = addFunction({
      fn: cb,
      outer,
      name: title,
      kind: "test",
      container,
      qualifiedName: q,
      ctx: { ...ctx, scope: ctx.scope },
      signature: oneLine(`${info.callee}("${title}")`, 160),
    });
    visitFunctionBody(cb, id, title, q, ctx);
    return true;
  };

  const handleCall = (node: SyntaxNode, ctx: Ctx, kind: "call" | "new") => {
    if (ctx.owner === null) return;
    const fn = node.childForFieldName(kind === "new" ? "constructor" : "function");
    if (!fn) return;
    let name: string | null = null;
    let receiver: string | null = null;
    let receiverKind: ReceiverKind | null = null;
    let nameNode: SyntaxNode = fn;
    if (fn.type === "identifier") {
      name = t(fn);
      if (kind === "call" && name === "require") return;
    } else if (fn.type === "super") {
      name = "constructor";
      receiver = "super";
      receiverKind = "super";
    } else if (fn.type === "import") {
      return;
    } else if (fn.type === "member_expression") {
      const obj = fn.childForFieldName("object");
      const prop = fn.childForFieldName("property");
      if (obj && prop) {
        name = t(prop);
        nameNode = prop;
        if (obj.type === "this") {
          receiver = "this";
          receiverKind = "self";
        } else if (obj.type === "super") {
          receiver = "super";
          receiverKind = "super";
        } else {
          const dotted = dottedText(obj, source);
          if (dotted) {
            receiver = dotted;
            receiverKind = "name";
          } else {
            receiver = oneLine(t(obj), 40);
            receiverKind = "expr";
          }
        }
      }
    }
    res.calls.push({
      ownerLocalId: ctx.owner,
      kind,
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

  const handleJsx = (node: SyntaxNode, ctx: Ctx) => {
    if (ctx.owner === null) return;
    const nm = node.childForFieldName("name");
    if (!nm) return;
    let name: string | null = null;
    let receiver: string | null = null;
    let nameNode: SyntaxNode = nm;
    if (nm.type === "identifier" && /^[A-Z]/.test(t(nm))) name = t(nm);
    else if (nm.type === "member_expression") {
      const o = dottedText(nm.childForFieldName("object"), source);
      const p = nm.childForFieldName("property");
      if (o && p && /^[A-Z]/.test(o)) {
        name = t(p);
        receiver = o;
        nameNode = p;
      }
    }
    if (!name) return;
    res.calls.push({
      ownerLocalId: ctx.owner,
      kind: "jsx",
      name,
      receiver,
      receiverKind: receiver ? "name" : null,
      calleeText: oneLine(t(nm), 60),
      line: nameNode.startPosition.row + 1,
      col: nameNode.startPosition.column + 1,
      endLine: nameNode.endPosition.row + 1,
      endCol: nameNode.endPosition.column + 1,
    });
  };

  const handleImport = (node: SyntaxNode) => {
    const line = node.startPosition.row + 1;
    const spec = stringValue(node.childForFieldName("source"), source);
    if (spec === null) return;
    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    if (!clause) return;
    for (const c of clause.namedChildren) {
      if (c.type === "identifier") {
        res.imports.push({ local: t(c), localPath: t(c), specifier: spec, imported: "default", reexport: false, line });
      } else if (c.type === "namespace_import") {
        const id = c.namedChildren.find((x) => x.type === "identifier");
        if (id) res.imports.push({ local: t(id), localPath: t(id), specifier: spec, imported: "*", reexport: false, line });
      } else if (c.type === "named_imports") {
        for (const s of c.namedChildren) {
          if (s.type !== "import_specifier") continue;
          const nm = s.childForFieldName("name");
          const al = s.childForFieldName("alias");
          if (!nm) continue;
          const imported = t(nm);
          const local = al ? t(al) : imported;
          res.imports.push({ local, localPath: local, specifier: spec, imported: imported === "default" ? "default" : imported, reexport: false, line });
        }
      }
    }
  };

  const handleExport = (node: SyntaxNode, ctx: Ctx) => {
    const isDefault = node.children.some((c) => c.type === "default");
    const decl = node.childForFieldName("declaration");
    const source_ = node.childForFieldName("source");
    const line = node.startPosition.row + 1;
    if (source_) {
      const spec = stringValue(source_, source);
      if (spec === null) return;
      const clause = node.namedChildren.find((c) => c.type === "export_clause");
      const nsExport = node.namedChildren.find((c) => c.type === "namespace_export");
      if (clause) {
        for (const s of clause.namedChildren) {
          if (s.type !== "export_specifier") continue;
          const nm = s.childForFieldName("name");
          const al = s.childForFieldName("alias");
          if (!nm) continue;
          res.imports.push({ local: al ? t(al) : t(nm), localPath: al ? t(al) : t(nm), specifier: spec, imported: t(nm), reexport: true, line });
        }
      } else if (nsExport) {
        const id = nsExport.namedChildren[0];
        if (id) res.imports.push({ local: t(id), localPath: t(id), specifier: spec, imported: "*", reexport: true, line });
      } else {
        res.imports.push({ local: "*", localPath: "*", specifier: spec, imported: "*wildcard", reexport: true, line });
      }
      return;
    }
    if (decl) {
      if (decl.type === "function_declaration" || decl.type === "generator_function_declaration") {
        handleNamedFunction(decl, node, ctx, isDefault);
      } else if (decl.type === "class_declaration" || decl.type === "abstract_class_declaration" || decl.type === "class") {
        handleClass(decl, node, ctx, isDefault);
      } else {
        visit(decl, ctx);
      }
      return;
    }
    const value = node.childForFieldName("value");
    if (value) {
      if (value.type === "identifier") {
        res.defaultExportName = t(value);
      } else {
        const fn = unwrapFn(value);
        if (fn) {
          const id = addFunction({ fn, outer: node, name: "default", kind: "function", container: null, qualifiedName: qn(ctx, "default"), ctx, isDefault: true });
          visitFunctionBody(fn, id, "default", "default", ctx);
        } else if (value.type === "class") {
          handleClass(value, node, ctx, true);
        } else {
          visit(value, ctx);
        }
      }
      return;
    }
    // export { a as default }
    const clause = node.namedChildren.find((c) => c.type === "export_clause");
    if (clause) {
      for (const s of clause.namedChildren) {
        const nm = s.childForFieldName("name");
        const al = s.childForFieldName("alias");
        if (nm && al && t(al) === "default") res.defaultExportName = t(nm);
      }
    }
  };

  const handleNamedFunction = (node: SyntaxNode, outer: SyntaxNode, ctx: Ctx, isDefault: boolean) => {
    const nameNode = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!nameNode || !body) {
      for (const c of node.namedChildren) visit(c, ctx);
      return;
    }
    const name = t(nameNode);
    const q = qn(ctx, name);
    const id = addFunction({ fn: node, outer, name, kind: "function", container: null, qualifiedName: q, ctx, isDefault });
    visitFunctionBody(node, id, name, q, ctx);
  };

  const visit = (node: SyntaxNode, ctx: Ctx): void => {
    switch (node.type) {
      case "export_statement":
        handleExport(node, ctx);
        return;
      case "function_declaration":
      case "generator_function_declaration":
        handleNamedFunction(node, node, ctx, false);
        return;
      case "class_declaration":
      case "abstract_class_declaration":
        handleClass(node, node, ctx, false);
        return;
      case "method_definition": {
        const nm = propName(node.childForFieldName("name"));
        if (nm && ctx.inClass && node.childForFieldName("body")) {
          const q = qn(ctx, nm);
          const id = addFunction({ fn: node, outer: node, name: nm, kind: "method", container: ctx.className, qualifiedName: q, ctx });
          visitFunctionBody(node, id, nm, q, ctx);
          return;
        }
        break;
      }
      case "variable_declarator":
        if (handleDeclarator(node, ctx)) return;
        break;
      case "assignment_expression":
        if (handleAssignment(node, ctx)) return;
        break;
      case "call_expression":
        if (isTestFile && handleTestCall(node, ctx)) return;
        handleCall(node, ctx, "call");
        break;
      case "new_expression":
        handleCall(node, ctx, "new");
        break;
      case "jsx_self_closing_element":
      case "jsx_opening_element":
        handleJsx(node, ctx);
        break;
      case "import_statement":
        handleImport(node);
        return;
    }
    for (const c of node.namedChildren) visit(c, ctx);
  };

  visit(root, { owner: null, scope: null, classId: null, className: null, inClass: false, prefix: "", describe: [] });
  return res;
}

/* ---------------- 流程图 IR ---------------- */

function flowIR(def: SyntaxNode, source: string): IRStmt[] {
  const t = (n: SyntaxNode | null) => (n ? slice(source, n) : "");
  const callsOf = (...nodes: (SyntaxNode | null)[]) =>
    collectCallNames(nodes, source, { call_expression: "function", new_expression: "constructor" }, isNestedDef);
  const lines = (n: SyntaxNode) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });
  const unparen = (s: string) => oneLine(s.replace(/^\s*\(/, "").replace(/\)\s*$/, ""), 70);
  const header = (n: SyntaxNode, body: SyntaxNode | null) => oneLine(source.slice(n.startIndex, body ? body.startIndex : n.endIndex), 70);

  const blockIR = (block: SyntaxNode | null): IRStmt[] => {
    if (!block) return [];
    const out: IRStmt[] = [];
    for (const c of block.namedChildren) out.push(...stmtIR(c));
    return out;
  };
  const bodyIR = (n: SyntaxNode | null): IRStmt[] => (!n ? [] : n.type === "statement_block" ? blockIR(n) : stmtIR(n));

  const stmtIR = (n: SyntaxNode): IRStmt[] => {
    const r = lines(n);
    switch (n.type) {
      case "comment":
      case "empty_statement":
        return [];
      case "statement_block":
        return blockIR(n);
      case "if_statement": {
        const cond = n.childForFieldName("condition");
        const alt = n.childForFieldName("alternative");
        let elseIR: IRStmt[] = [];
        if (alt) {
          const inner = alt.type === "else_clause" ? (alt.namedChildren[0] ?? null) : alt;
          elseIR = bodyIR(inner);
        }
        return [{ t: "if", ...r, cond: unparen(t(cond)), calls: callsOf(cond), then: bodyIR(n.childForFieldName("consequence")), else: elseIR }];
      }
      case "for_statement":
      case "for_in_statement":
      case "while_statement": {
        const body = n.childForFieldName("body");
        const isWhile = n.type === "while_statement";
        return [
          {
            t: "loop",
            kind: isWhile ? "while" : "for",
            ...r,
            cond: header(n, body),
            calls: callsOf(n.childForFieldName("condition"), n.childForFieldName("right"), n.childForFieldName("initializer")),
            body: bodyIR(body),
            orElse: [],
          },
        ];
      }
      case "do_statement": {
        const cond = n.childForFieldName("condition");
        return [{ t: "loop", kind: "do", ...r, cond: `while ${unparen(t(cond))}`, calls: callsOf(cond), body: bodyIR(n.childForFieldName("body")), orElse: [] }];
      }
      case "switch_statement": {
        const value = n.childForFieldName("value");
        const body = n.childForFieldName("body");
        const cases = (body ? body.namedChildren : [])
          .filter((c) => c.type === "switch_case" || c.type === "switch_default")
          .map((c) => {
            const stmts: IRStmt[] = [];
            for (const b of c.childrenForFieldName("body")) stmts.push(...stmtIR(b));
            const isDefault = c.type === "switch_default";
            const v = c.childForFieldName("value");
            return { label: isDefault ? "default" : `case ${oneLine(t(v), 50)}`, ...lines(c), body: stmts, isDefault };
          });
        return [{ t: "switch", ...r, disc: unparen(t(value)), calls: callsOf(value), fallthrough: true, cases }];
      }
      case "try_statement": {
        const handler = n.childForFieldName("handler");
        const fin = n.childForFieldName("finalizer");
        const handlers = handler
          ? [
              {
                label: `catch${handler.childForFieldName("parameter") ? ` (${oneLine(t(handler.childForFieldName("parameter")), 30)})` : ""}`,
                ...lines(handler),
                body: bodyIR(handler.childForFieldName("body")),
              },
            ]
          : [];
        return [{ t: "try", ...r, body: bodyIR(n.childForFieldName("body")), handlers, orElse: [], finally: fin ? bodyIR(fin.childForFieldName("body")) : [] }];
      }
      case "return_statement":
        return [{ t: "return", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
      case "throw_statement":
        return [{ t: "throw", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
      case "break_statement":
        return [{ t: "break", ...r }];
      case "continue_statement":
        return [{ t: "continue", ...r }];
      case "labeled_statement": {
        const b = n.childForFieldName("body");
        return b ? stmtIR(b) : [];
      }
      case "function_declaration":
      case "generator_function_declaration":
      case "class_declaration": {
        const nm = n.childForFieldName("name");
        return [{ t: "stmt", ...r, label: `${n.type === "class_declaration" ? "class" : "function"} ${t(nm)}（嵌套定义）`, calls: [] }];
      }
      default:
        return [{ t: "stmt", ...r, label: oneLine(t(n), 70), calls: callsOf(n) }];
    }
  };

  const body = def.childForFieldName("body");
  if (!body) return [];
  if (body.type === "statement_block") return blockIR(body);
  // 表达式体箭头函数：隐式 return
  return [{ t: "return", startLine: body.startPosition.row + 1, endLine: body.endPosition.row + 1, label: `return ${oneLine(t(body), 60)}`, calls: callsOf(body) }];
}

/* ---------------- 变量分析 ---------------- */

const DESTRUCT_WRAPPERS = new Set(["object_pattern", "array_pattern", "pair_pattern", "assignment_pattern", "rest_pattern", "object_assignment_pattern", "parenthesized_expression", "spread_element"]);

function isWriteTarget(n: SyntaxNode): boolean {
  let cur = n;
  while (cur.parent && DESTRUCT_WRAPPERS.has(cur.parent.type)) {
    const p = cur.parent;
    if (p.type === "pair_pattern" && p.childForFieldName("value")?.id !== cur.id) return false;
    if (p.type === "assignment_pattern" && p.childForFieldName("left")?.id !== cur.id) return false;
    cur = p;
  }
  const p = cur.parent;
  if (!p) return false;
  if (p.type === "assignment_expression" || p.type === "augmented_assignment_expression") return p.childForFieldName("left")?.id === cur.id;
  if (p.type === "update_expression") return p.childForFieldName("argument")?.id === cur.id;
  return false;
}

function analyzeVariables(def: SyntaxNode, source: string): VariableInfo[] {
  const t = (n: SyntaxNode) => slice(source, n);
  const vc = new VarCollector();
  const handled = new Set<number>();

  for (const p of parseParams(def, source)) {
    for (const id of p.idNodes) {
      handled.add(id.id);
      vc.declare(t(id), id, { kind: "param", typeText: p.info.type, snippet: p.info.display });
    }
  }
  const body = def.childForFieldName("body");
  if (!body) return vc.build(source);

  let classNode: SyntaxNode | null = null;
  {
    let cur: SyntaxNode | null = def.parent;
    while (cur) {
      if (cur.type === "class_body") {
        classNode = cur;
        break;
      }
      if (FN_TYPES.has(cur.type) || cur.type === "method_definition") break;
      cur = cur.parent;
    }
  }

  const tagsFor = (n: SyntaxNode): string[] => {
    const tags: string[] = [];
    if (hasAncestor(n, (a) => a.type === "return_statement", def)) tags.push("returned");
    if (
      inFieldOf(n, ["if_statement", "while_statement", "do_statement", "for_statement", "ternary_expression"], "condition", def)
    )
      tags.push("condition");
    if (hasAncestor(n, (a) => a.type === "throw_statement", def)) tags.push("raised");
    return tags;
  };

  const fieldNames: string[] = [];
  const fieldFirstWrite = new Map<string, SyntaxNode>();

  walk(body, (n) => {
    if (n.id !== body.id && NESTED_DEF.has(n.type) && n.type !== "method_definition") return false;
    switch (n.type) {
      case "variable_declarator": {
        const nameNode = n.childForFieldName("name");
        if (!nameNode) return true;
        const decl = n.parent;
        const keyword = decl && (decl.type === "lexical_declaration" || decl.type === "variable_declaration") ? (decl.children[0] ? t(decl.children[0]) : null) : null;
        const inLoopHeader = !!decl?.parent && (decl.parent.type === "for_statement" || decl.parent.type === "for_in_statement");
        const ty = n.childForFieldName("type");
        for (const id of patternIdentifiers(nameNode)) {
          handled.add(id.id);
          vc.declare(t(id), id, {
            kind: inLoopHeader ? "loop" : "local",
            declKeyword: keyword,
            typeText: ty ? oneLine(t(ty).replace(/^:\s*/, ""), 40) : null,
            snippet: oneLine(t(n), 100),
          });
        }
        return true;
      }
      case "for_in_statement": {
        const left = n.childForFieldName("left");
        if (left && n.children.some((c) => c.type === "const" || c.type === "let" || c.type === "var")) {
          for (const id of patternIdentifiers(left)) {
            handled.add(id.id);
            vc.declare(t(id), id, { kind: "loop", declKeyword: t(n.children.find((c) => ["const", "let", "var"].includes(c.type))!), snippet: oneLine(source.slice(n.startIndex, n.childForFieldName("body")?.startIndex ?? n.endIndex), 70) });
          }
        }
        return true;
      }
      case "catch_clause": {
        const param = n.childForFieldName("parameter");
        for (const id of patternIdentifiers(param)) {
          handled.add(id.id);
          vc.declare(t(id), id, { kind: "catch", snippet: `catch (${t(id)})` });
        }
        return true;
      }
      case "member_expression": {
        const obj = n.childForFieldName("object");
        const prop = n.childForFieldName("property");
        if (obj?.type === "this" && prop && (prop.type === "property_identifier" || prop.type === "private_property_identifier")) {
          const parent = n.parent;
          const isCallee = parent?.type === "call_expression" && parent.childForFieldName("function")?.id === n.id;
          if (!isCallee) {
            const name = `this.${t(prop)}`;
            const write = isWriteTarget(n);
            if (!fieldNames.includes(name)) {
              fieldNames.push(name);
              vc.declareField(name);
            }
            if (write && !fieldFirstWrite.has(name)) fieldFirstWrite.set(name, n);
            vc.occur(name, prop, write ? "write" : "read", tagsFor(n));
          }
        }
        return true;
      }
      case "identifier":
      case "shorthand_property_identifier":
      case "shorthand_property_identifier_pattern": {
        if (handled.has(n.id)) return true;
        const p = n.parent;
        if (p && p.type === "pair" && p.childForFieldName("key")?.id === n.id) return true;
        if (p && (p.type === "import_specifier" || p.type === "labeled_statement")) return true;
        const write = n.type === "shorthand_property_identifier_pattern" ? true : isWriteTarget(n);
        vc.occur(t(n), n, write ? "write" : "read", tagsFor(n));
        return true;
      }
      default:
        return true;
    }
  });

  for (const name of fieldNames) {
    const attr = name.slice("this.".length);
    const mk = (node: SyntaxNode, stmt: SyntaxNode, where: "method" | "class", suffix = "") => ({
      line: node.startPosition.row + 1,
      col: node.startPosition.column + 1,
      endCol: node.endPosition.column + 1,
      snippet: oneLine(t(stmt), 90) + suffix,
      where,
    });
    const w = fieldFirstWrite.get(name);
    if (w) {
      let stmt: SyntaxNode = w;
      while (stmt.parent && !["expression_statement", "assignment_expression"].includes(stmt.type)) stmt = stmt.parent;
      vc.setFieldDefinition(name, mk(w, stmt, "method"));
      continue;
    }
    if (!classNode) continue;
    let found: { node: SyntaxNode; stmt: SyntaxNode; method: string | null } | null = null;
    for (const m of classNode.namedChildren) {
      if (m.type === "method_definition" && propNameOf(m, source) === "constructor") {
        const pp = parseParams(m, source).find((x) => x.propertyField && x.info.name === attr);
        if (pp && pp.idNodes[0]) {
          found = { node: pp.idNodes[0], stmt: pp.idNodes[0].parent ?? pp.idNodes[0], method: "constructor（参数属性）" };
          break;
        }
      }
      if (m.type === "public_field_definition" || m.type === "field_definition") {
        const nm = m.childForFieldName("name") ?? m.childForFieldName("property");
        if (nm && t(nm) === attr) {
          found = { node: nm, stmt: m, method: null };
          break;
        }
      }
    }
    if (!found) {
      walk(classNode, (n) => {
        if (found) return false;
        if (n.type === "member_expression") {
          const o = n.childForFieldName("object");
          const p = n.childForFieldName("property");
          if (o?.type === "this" && p && t(p) === attr && isWriteTarget(n)) {
            let m: SyntaxNode | null = n.parent;
            while (m && m.type !== "method_definition") m = m.parent;
            let stmt: SyntaxNode = n;
            while (stmt.parent && stmt.type !== "expression_statement") stmt = stmt.parent;
            found = { node: n, stmt, method: m ? propNameOf(m, source) : null };
            return false;
          }
        }
        return true;
      });
    }
    const f = found as { node: SyntaxNode; stmt: SyntaxNode; method: string | null } | null;
    if (f) vc.setFieldDefinition(name, mk(f.node, f.stmt, "class", f.method ? `   // 于 ${f.method}()` : "   // 类字段声明"));
  }
  return vc.build(source);
}

function propNameOf(m: SyntaxNode, source: string): string | null {
  const n = m.childForFieldName("name");
  return n ? slice(source, n) : null;
}

/* ---------------- 导入解析 ---------------- */

function normalizePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

function probe(base: string, index: FileIndex): string | null {
  if (/\.[cm]?[jt]sx?$/.test(base) && index.has(base)) return base;
  const stems = [base];
  const m = /^(.*)\.(js|jsx|mjs|cjs)$/.exec(base);
  if (m) stems.push(m[1]);
  for (const stem of stems) {
    for (const e of EXTS) if (index.has(stem + e)) return stem + e;
    for (const e of EXTS) if (index.has(`${stem}/index${e}`)) return `${stem}/index${e}`;
  }
  return null;
}

function resolveImport(fromPath: string, spec: string, index: FileIndex): ImportResolution {
  if (spec.startsWith(".")) {
    const base = normalizePath(`${dirname(fromPath)}/${spec}`);
    if (base === null) return { kind: "unresolved", reason: `相对路径 ${spec} 越出项目根目录` };
    const hit = probe(base, index);
    return hit ? { kind: "project", path: hit, guess: false } : { kind: "unresolved", reason: `相对导入 ${spec} 未在项目中找到文件` };
  }
  if (spec.startsWith("node:")) return { kind: "external" };
  if (/^(@|~|#)\//.test(spec)) {
    const rest = spec.slice(2);
    // 依次尝试：项目根、以及导入文件各级祖先目录（兼容 monorepo / 子项目）下的 src/、app/、lib/
    const bases: string[] = [];
    let d = dirname(fromPath);
    for (;;) {
      bases.push(d);
      if (d === "") break;
      d = dirname(d);
    }
    bases.reverse();
    for (const baseDir of [...bases.slice(0, 1), ...bases.slice(1).reverse()]) {
      for (const prefix of ["src/", "", "app/", "lib/"]) {
        const b = normalizePath(`${baseDir}/${prefix}${rest}`);
        const hit = b ? probe(b, index) : null;
        if (hit) return { kind: "project", path: hit, guess: true };
      }
    }
    return { kind: "unresolved", reason: `路径别名 ${spec} 无法根据 tsconfig/jsconfig 确定` };
  }
  for (const prefix of ["", "src/"]) {
    const b = normalizePath(prefix + spec);
    const hit = b ? probe(b, index) : null;
    if (hit && !/^@?[a-z0-9-]+$/.test(spec)) return { kind: "project", path: hit, guess: true };
  }
  return { kind: "external" };
}

function makePlugin(id: LanguageId, label: string, extensions: string[]): LanguagePlugin {
  return {
    id,
    label,
    extensions,
    grammarFor: (ext) => (id === "javascript" ? "javascript" : ext === ".tsx" ? "tsx" : "typescript"),
    isTestFile: testFile,
    extract,
    flowIR,
    analyzeVariables,
    resolveImport,
    joinSubmodule: () => null,
    builtinFunctions: BUILTIN_FUNCTIONS,
    globalObjects: GLOBAL_OBJECTS,
    builtinMethods: BUILTIN_METHODS,
    constructorNames: ["constructor"],
  };
}

export const javascriptPlugin = makePlugin("javascript", "JavaScript", [".js", ".jsx", ".mjs", ".cjs"]);
export const typescriptPlugin = makePlugin("typescript", "TypeScript", [".ts", ".tsx", ".mts", ".cts"]);

export type { ParamInfo };
