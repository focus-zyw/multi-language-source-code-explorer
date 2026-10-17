import type { ExtractResult, ExtractedSymbol, ImportResolution, LanguagePlugin, ParamInfo, SyntaxNode } from "../types.ts";
import { VarCollector, computeMetrics, oneLine, rangeOf, slice, walk, inFieldOf, type MetricConfig } from "../util.ts";
import { bracedFlow } from "./braced-flow.ts";

const definitions = new Set(["function_declaration", "method_declaration", "func_literal"]);
const metricConfig: MetricConfig = {
  isBranch: (n) => ["if_statement", "expression_case", "type_case", "communication_case"].includes(n.type),
  isLoop: (n) => n.type === "for_statement", isHandler: () => false,
  isReturn: (n) => n.type === "return_statement",
  isThrow: (n) => n.type === "call_expression" && n.childForFieldName("function")?.text === "panic",
  isAwait: () => false, isYield: () => false,
  isBoolOp: (n) => n.type === "binary_expression" && ["&&", "||"].includes(n.childForFieldName("operator")?.text ?? ""),
  isNestedDef: (n) => definitions.has(n.type),
};
const dirname = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const typeName = (value: string) => value.replace(/^\*+/, "").replace(/\[.*$/, "").trim();

function parameters(list: SyntaxNode | null, source: string): { info: ParamInfo; node: SyntaxNode }[] {
  return (list?.namedChildren ?? []).filter((n) => ["parameter_declaration", "variadic_parameter_declaration"].includes(n.type)).flatMap((p) => {
    const names = p.childrenForFieldName("name");
    const type = p.childForFieldName("type");
    return (names.length ? names : type ? [type] : []).map((node) => ({ node, info: { name: names.length ? slice(source, node) : "", display: oneLine(names.length ? `${slice(source, node)} ${type ? slice(source, type) : ""}` : slice(source, p), 100), type: type ? slice(source, type) : null, defaultValue: null } }));
  });
}

function docOf(n: SyntaxNode, source: string) {
  const comments: string[] = [];
  let previous = n.previousNamedSibling;
  let row = n.startPosition.row;
  while (previous?.type === "comment" && previous.endPosition.row >= row - 1) {
    comments.unshift(slice(source, previous).replace(/^\/\/\s?/, "").replace(/^\/\*|\*\/$/g, "").trim());
    row = previous.startPosition.row;
    previous = previous.previousNamedSibling;
  }
  return comments.join("\n") || null;
}

function extract(root: SyntaxNode, source: string, path: string): ExtractResult {
  const text = (n: SyntaxNode | null) => n ? slice(source, n) : "";
  const result: ExtractResult = { symbols: [], calls: [], imports: [], hints: [], defaultExportName: null, hasSyntaxErrors: root.hasError,
    moduleName: root.namedChildren.find((n) => n.type === "package_clause")?.namedChildren[0]?.text ?? null };
  const classes = new Map<string, number>();
  for (const declaration of root.namedChildren.filter((n) => n.type === "type_declaration")) {
    for (const spec of declaration.namedChildren.filter((n) => n.type === "type_spec")) {
      const name = spec.childForFieldName("name");
      const type = spec.childForFieldName("type");
      if (!name || !type || !["struct_type", "interface_type"].includes(type.type)) continue;
      const localId = result.symbols.length;
      classes.set(text(name), localId);
      result.symbols.push({ localId, parentLocalId: null, classLocalId: null, kind: "class", name: text(name), qualifiedName: text(name), container: null,
        isAsync: false, isGenerator: false, isTest: false, isDefaultExport: false, signature: `type ${text(name)} ${type.type === "struct_type" ? "struct" : "interface"}`,
        params: [], decorators: [], docstring: docOf(declaration, source), returnType: null, bases: [], ...rangeOf(spec), defStartIndex: spec.startIndex, defEndIndex: spec.endIndex,
        metrics: computeMetrics(spec, metricConfig, 0).metrics });
    }
  }
  const hint = (owner: number, variable: string, type: string, sourceKind: "annotation" | "constructor") => {
    const name = typeName(type);
    if (/^[A-Za-z_][\w.]*$/.test(name) && !/^(?:int\d*|uint\d*|float\d+|string|bool|byte|rune|error|any|uintptr)$/.test(name)) result.hints.push({ ownerLocalId: owner, classLocalId: null, variable, typeName: name.split(".").at(-1)!, source: sourceKind, field: false });
  };
  for (const def of root.namedChildren.filter((n) => ["function_declaration", "method_declaration"].includes(n.type))) {
    const name = def.childForFieldName("name");
    const body = def.childForFieldName("body");
    if (!name || !body) continue;
    const receiver = parameters(def.childForFieldName("receiver"), source)[0];
    const container = receiver?.info.type ? typeName(receiver.info.type) : null;
    const parent = container ? classes.get(container) ?? null : null;
    const params = parameters(def.childForFieldName("parameters"), source);
    const localId = result.symbols.length;
    const isTest = /_test\.go$/.test(path) && /^(?:Test|Benchmark|Fuzz|Example)(?:[A-Z_]|$)/.test(text(name));
    const symbol: ExtractedSymbol = { localId, parentLocalId: parent, classLocalId: parent, kind: isTest ? "test" : receiver ? "method" : "function", name: text(name), qualifiedName: container ? `${container}.${text(name)}` : text(name), container,
      isAsync: false, isGenerator: false, isTest, isDefaultExport: false, signature: oneLine(source.slice(def.startIndex, body.startIndex), 200),
      params: params.map((p) => p.info), decorators: [], docstring: docOf(def, source), returnType: text(def.childForFieldName("result")) || null, bases: [], ...rangeOf(def), defStartIndex: def.startIndex, defEndIndex: def.endIndex,
      metrics: computeMetrics(def, metricConfig, params.length).metrics };
    result.symbols.push(symbol);
    for (const p of [...params, ...(receiver ? [receiver] : [])]) if (p.info.name && p.info.type) hint(localId, p.info.name, p.info.type, "annotation");
    walk(body, (n) => {
      if (definitions.has(n.type)) return false;
      if (n.type === "short_var_declaration") {
        const left = n.childForFieldName("left")?.namedChildren ?? [];
        const right = n.childForFieldName("right")?.namedChildren ?? [];
        left.forEach((variable, i) => {
          const value = right[i];
          if (value?.type === "composite_literal") hint(localId, text(variable), text(value.childForFieldName("type")), "constructor");
          else if (value?.type === "unary_expression" && value.namedChildren[0]?.type === "composite_literal") hint(localId, text(variable), text(value.namedChildren[0].childForFieldName("type")), "constructor");
          else if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "new") hint(localId, text(variable), text(value.childForFieldName("arguments")?.namedChildren[0] ?? null), "constructor");
        });
      }
      if (n.type === "var_spec") {
        const type = n.childForFieldName("type");
        if (type) for (const variable of n.childrenForFieldName("name")) hint(localId, text(variable), text(type), "annotation");
      }
      if (n.type !== "call_expression") return;
      const callee = n.childForFieldName("function");
      if (!callee) return;
      const recv = callee.type === "selector_expression" ? callee.childForFieldName("operand") : null;
      const field = callee.type === "selector_expression" ? callee.childForFieldName("field") : callee.type === "identifier" ? callee : null;
      result.calls.push({ ownerLocalId: localId, kind: "call", name: field ? text(field) : null, receiver: recv ? text(recv) : null, receiverKind: recv ? /^[\w.]+$/.test(text(recv)) ? "name" : "expr" : null, calleeText: oneLine(text(callee), 120), ...rangeOf(callee), line: callee.startPosition.row + 1, col: callee.startPosition.column + 1 });
    });
  }
  walk(root, (n) => {
    if (n.type !== "import_spec") return;
    const specifier = text(n.childForFieldName("path")).replace(/^["`]|["`]$/g, "");
    const local = text(n.childForFieldName("name")) || specifier.split("/").at(-1)!;
    result.imports.push({ local, localPath: local, specifier, imported: local === "." ? "*wildcard" : "*", reexport: false, line: n.startPosition.row + 1 });
  });
  return result;
}

function analyzeVariables(def: SyntaxNode, source: string) {
  const collector = new VarCollector();
  const defined = new Set<number>();
  const receiver = parameters(def.childForFieldName("receiver"), source)[0];
  const declare = (node: SyntaxNode, kind: "param" | "local" | "loop", type: string | null = null) => {
    if (node.text === "_") return;
    collector.declare(slice(source, node), node, { kind, typeText: type, snippet: oneLine(node.parent?.text ?? node.text, 100) });
    defined.add(node.startIndex);
  };
  for (const field of ["parameters", "receiver", "result"]) for (const p of parameters(def.childForFieldName(field), source)) if (p.info.name) declare(p.node, "param", p.info.type);
  walk(def, (n) => {
    if (n.id !== def.id && definitions.has(n.type)) return false;
    if (n.type === "short_var_declaration" || n.type === "range_clause") for (const id of n.childForFieldName("left")?.namedChildren ?? []) if (id.type === "identifier") declare(id, n.type === "range_clause" || n.parent?.type === "for_clause" ? "loop" : "local");
    if (n.type === "var_spec") for (const id of n.childrenForFieldName("name")) declare(id, "local", n.childForFieldName("type")?.text ?? null);
  });
  walk(def.childForFieldName("body") ?? def, (n) => {
    if (n.id !== def.id && definitions.has(n.type)) return false;
    const write = !!inFieldOf(n, ["assignment_statement", "short_var_declaration"], "left", def) || ["inc_statement", "dec_statement"].includes(n.parent?.type ?? "");
    if (n.type === "selector_expression" && receiver && n.childForFieldName("operand")?.text === receiver.info.name) {
      const name = slice(source, n);
      collector.declareField(name);
      collector.occur(name, n, write ? "write" : "read");
      const receiverType = typeName(receiver.info.type ?? "");
      let root = def;
      while (root.parent) root = root.parent;
      walk(root, (candidate) => {
        if (candidate.type !== "type_spec" || candidate.childForFieldName("name")?.text !== receiverType) return;
        walk(candidate, (field) => {
          if (field.type !== "field_declaration") return;
          const id = field.childrenForFieldName("name").find((id) => id.text === n.childForFieldName("field")?.text);
          if (id) collector.setFieldDefinition(name, { line: id.startPosition.row + 1, col: id.startPosition.column + 1, endCol: id.endPosition.column + 1, snippet: oneLine(field.text), where: "class" });
        });
        return false;
      });
    }
    if (n.type !== "identifier" || defined.has(n.startIndex)) return;
    const tags: string[] = [];
    if (inFieldOf(n, ["if_statement", "for_clause"], "condition", def)) tags.push("condition");
    let p = n.parent;
    while (p && p.id !== def.id) { if (p.type === "return_statement") { tags.push("returned"); break; } p = p.parent; }
    collector.occur(n.text, n, write ? "write" : "read", tags);
  });
  return collector.build(source);
}

function resolveImport(_from: string, specifier: string, index: Parameters<LanguagePlugin["resolveImport"]>[2]): ImportResolution {
  if (!specifier.includes("/")) return { kind: "external" };
  const dirs = [...new Set(index.bySuffix(".go").filter((p) => !/_test\.go$/.test(p)).map(dirname))].filter((dir) => dir && (specifier === dir || specifier.endsWith(`/${dir}`)));
  dirs.sort((a, b) => b.length - a.length);
  if (!dirs.length) return { kind: "external" };
  const matches = index.bySuffix(".go").filter((p) => dirname(p) === dirs[0] && !/_test\.go$/.test(p)).sort();
  return { kind: "project", path: matches[0], guess: true };
}

export const goPlugin: LanguagePlugin = {
  id: "go", label: "Go", extensions: [".go"], grammarFor: () => "go", isTestFile: (p) => /_test\.go$/.test(p), extract,
  flowIR: (def, source) => bracedFlow(def, source, "go"), analyzeVariables, resolveImport, joinSubmodule: () => null,
  builtinFunctions: new Set("append cap clear close complex copy delete imag len make max min new panic print println real recover".split(" ")),
  globalObjects: new Set(), builtinMethods: new Set(), constructorNames: [],
};
