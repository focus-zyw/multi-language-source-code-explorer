import type { ExtractResult, ExtractedSymbol, FileIndex, ImportResolution, LanguagePlugin, ParamInfo, SyntaxNode } from "../types.ts";
import { VarCollector, computeMetrics, inFieldOf, oneLine, rangeOf, slice, walk, type MetricConfig } from "../util.ts";
import { bracedFlow } from "./braced-flow.ts";

const classTypes = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
const methodTypes = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);
const nested = (n: SyntaxNode) => classTypes.has(n.type) || methodTypes.has(n.type) || n.type === "lambda_expression";
const config: MetricConfig = {
  isBranch: (n) => ["if_statement", "switch_label", "ternary_expression"].includes(n.type),
  isLoop: (n) => ["for_statement", "enhanced_for_statement", "while_statement", "do_statement"].includes(n.type),
  isHandler: (n) => n.type === "catch_clause", isReturn: (n) => n.type === "return_statement", isThrow: (n) => n.type === "throw_statement",
  isAwait: () => false, isYield: () => false,
  isBoolOp: (n) => n.type === "binary_expression" && ["&&", "||"].includes(n.childForFieldName("operator")?.text ?? ""), isNestedDef: nested,
};
function params(def: SyntaxNode, source: string): { node: SyntaxNode; info: ParamInfo }[] {
  return (def.childForFieldName("parameters")?.namedChildren ?? []).filter((p) => ["formal_parameter", "spread_parameter", "receiver_parameter"].includes(p.type)).flatMap((p) => {
    const node = p.childForFieldName("name") ?? p.namedChildren.find((n) => n.type === "variable_declarator")?.childForFieldName("name");
    if (!node) return [];
    const type = p.childForFieldName("type") ?? p.namedChildren.find((n) => n.id !== node.id && n.type !== "modifiers" && n.type !== "variable_declarator");
    return [{ node, info: { name: node.text, display: oneLine(slice(source, p), 100), type: type?.text ?? null, defaultValue: null } }];
  });
}
function annotations(def: SyntaxNode): string[] {
  return (def.namedChildren.find((n) => n.type === "modifiers")?.namedChildren ?? []).filter((n) => ["annotation", "marker_annotation"].includes(n.type)).map((n) => n.text);
}
const simpleType = (text: string) => text.replace(/<.*>/g, "").replace(/\[\]|\.\.\./g, "").trim().split(".").at(-1)!;
function doc(def: SyntaxNode) {
  const previous = def.previousNamedSibling;
  return previous && ["block_comment", "line_comment"].includes(previous.type) && previous.endPosition.row >= def.startPosition.row - 1
    ? previous.text.replace(/^\/\*\*?|\*\/$/g, "").split("\n").map((line) => line.replace(/^\s*\*\s?|^\s*\/\/\s?/, "")).join("\n").trim() || null : null;
}

function extract(root: SyntaxNode, source: string, path: string): ExtractResult {
  const result: ExtractResult = { symbols: [], calls: [], imports: [], hints: [], defaultExportName: null, hasSyntaxErrors: root.hasError,
    moduleName: root.namedChildren.find((n) => n.type === "package_declaration")?.namedChildren.find((n) => n.type !== "annotation")?.text ?? "" };
  const hint = (owner: number | null, classId: number | null, variable: string, type: string, field = false, sourceKind: "annotation" | "constructor" = "annotation") => {
    const name = simpleType(type);
    if (/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name) && !/^(?:byte|short|int|long|float|double|boolean|char|void|var)$/.test(name)) result.hints.push({ ownerLocalId: owner, classLocalId: classId, variable, typeName: name, source: sourceKind, field });
  };
  for (const n of root.namedChildren.filter((n) => n.type === "import_declaration")) {
    const raw = n.text.replace(/^import\s+/, "").replace(/;\s*$/, "").trim();
    const isStatic = raw.startsWith("static ");
    const spec = raw.replace(/^static\s+/, "");
    const wildcard = spec.endsWith(".*");
    const parts = spec.split(".");
    const imported = wildcard ? "*wildcard" : parts.at(-1)!;
    result.imports.push({ local: wildcard ? "*" : imported, localPath: wildcard ? "*" : imported,
      specifier: wildcard || isStatic ? parts.slice(0, -1).join(".") : spec, imported, reexport: false, line: n.startPosition.row + 1 });
  }
  const visit = (node: SyntaxNode, scope: number | null, classId: number | null) => {
    if (classTypes.has(node.type)) {
      const name = node.childForFieldName("name");
      const body = node.childForFieldName("body");
      if (!name || !body) return;
      const localId = result.symbols.length;
      const parentName = classId !== null ? result.symbols[classId].qualifiedName : null;
      const bases = [node.childForFieldName("superclass"), node.childForFieldName("interfaces")].flatMap((n) => n?.namedChildren.flatMap((c) => c.type === "type_list" ? c.namedChildren.map((x) => x.text) : [c.text]) ?? []);
      result.symbols.push({ localId, parentLocalId: scope, classLocalId: classId, kind: "class", name: name.text, qualifiedName: parentName ? `${parentName}.${name.text}` : name.text, container: null,
        isAsync: false, isGenerator: false, isTest: false, isDefaultExport: false, signature: oneLine(source.slice(node.startIndex, body.startIndex), 200), params: [], decorators: annotations(node), docstring: doc(node), returnType: null, bases,
        ...rangeOf(node), defStartIndex: node.startIndex, defEndIndex: node.endIndex, metrics: computeMetrics(node, config, 0).metrics });
      for (const field of body.namedChildren.filter((n) => n.type === "field_declaration")) {
        const type = field.childForFieldName("type");
        if (type) for (const variable of field.childrenForFieldName("declarator")) { const id = variable.childForFieldName("name"); if (id) hint(null, localId, id.text, type.text, true); }
      }
      for (const child of body.namedChildren) visit(child, localId, localId);
      return;
    }
    if (methodTypes.has(node.type)) {
      const body = node.childForFieldName("body");
      const name = node.childForFieldName("name");
      if (!body || !name || classId === null) return;
      const ownerClass = result.symbols[classId];
      const constructor = node.type !== "method_declaration";
      const decorators = annotations(node);
      const isTest = !constructor && (decorators.some((d) => /^@(?:[\w.]*\.)?(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(d)) || /(?:Test|Tests|TestCase)\.java$/.test(path) && ownerClass.bases.some((b) => /TestCase$/.test(b)) && /^test[A-Z_]/.test(name.text));
      const parameters = params(node, source);
      const localId = result.symbols.length;
      const symbol: ExtractedSymbol = { localId, parentLocalId: scope, classLocalId: classId, kind: isTest ? "test" : "method", name: constructor ? "constructor" : name.text,
        qualifiedName: `${ownerClass.qualifiedName}.${name.text}`, container: ownerClass.name, isAsync: false, isGenerator: false, isTest, isDefaultExport: false,
        signature: oneLine(source.slice(node.startIndex, body.startIndex), 200), params: parameters.map((p) => p.info), decorators, docstring: doc(node), returnType: node.childForFieldName("type")?.text ?? null, bases: [],
        ...rangeOf(node), defStartIndex: node.startIndex, defEndIndex: node.endIndex, metrics: computeMetrics(node, config, parameters.length).metrics };
      result.symbols.push(symbol);
      for (const p of parameters) if (p.info.type) hint(localId, classId, p.info.name, p.info.type);
      walk(body, (n) => {
        if (nested(n)) return false;
        if (n.type === "local_variable_declaration") {
          const type = n.childForFieldName("type");
          for (const variable of n.childrenForFieldName("declarator")) {
            const id = variable.childForFieldName("name");
            const value = variable.childForFieldName("value");
            if (id && type && type.text !== "var") hint(localId, classId, id.text, type.text);
            else if (id && value?.type === "object_creation_expression") hint(localId, classId, id.text, value.childForFieldName("type")?.text ?? "", false, "constructor");
          }
        }
        if (n.type !== "method_invocation" && n.type !== "object_creation_expression") return;
        const creation = n.type === "object_creation_expression";
        const callee = n.childForFieldName(creation ? "type" : "name");
        if (!callee) return;
        const receiver = n.childForFieldName("object");
        const recv = receiver?.text ?? null;
        result.calls.push({ ownerLocalId: localId, kind: creation ? "new" : "call", name: creation ? simpleType(callee.text) : callee.text, receiver: recv,
          receiverKind: recv === "this" ? "self" : recv === "super" ? "super" : recv ? /^[\w$.]+$/.test(recv) ? "name" : "expr" : null,
          calleeText: creation ? `new ${callee.text}` : recv ? `${recv}.${callee.text}` : callee.text,
          line: (receiver ?? callee).startPosition.row + 1, col: (receiver ?? callee).startPosition.column + 1, endLine: callee.endPosition.row + 1, endCol: callee.endPosition.column + 1 });
      });
      return;
    }
    if (node.type !== "lambda_expression" && node.type !== "object_creation_expression") for (const child of node.namedChildren) visit(child, scope, classId);
  };
  for (const node of root.namedChildren) visit(node, null, null);
  return result;
}

function analyzeVariables(def: SyntaxNode, source: string) {
  const collector = new VarCollector();
  const declared = new Set<number>();
  const declare = (node: SyntaxNode, kind: "param" | "local" | "loop" | "catch", type: string | null = null) => {
    collector.declare(node.text, node, { kind, typeText: type, snippet: oneLine(node.parent?.text ?? node.text, 100) }); declared.add(node.startIndex);
  };
  for (const p of params(def, source)) declare(p.node, "param", p.info.type);
  walk(def, (n) => {
    if (n.id !== def.id && nested(n)) return false;
    if (n.type === "local_variable_declaration") for (const variable of n.childrenForFieldName("declarator")) { const id = variable.childForFieldName("name"); if (id) declare(id, n.parent?.type === "for_statement" ? "loop" : "local", n.childForFieldName("type")?.text ?? null); }
    if (n.type === "enhanced_for_statement" || n.type === "catch_formal_parameter") { const id = n.childForFieldName("name"); if (id) declare(id, n.type === "enhanced_for_statement" ? "loop" : "catch", n.childForFieldName("type")?.text ?? n.namedChildren.find((c) => c.type === "catch_type")?.text ?? null); }
  });
  let cls = def.parent;
  while (cls && !classTypes.has(cls.type)) cls = cls.parent;
  const fields = new Map<string, SyntaxNode>();
  for (const field of cls?.childForFieldName("body")?.namedChildren.filter((n) => n.type === "field_declaration") ?? []) for (const variable of field.childrenForFieldName("declarator")) { const id = variable.childForFieldName("name"); if (id) fields.set(id.text, id); }
  const recordField = (name: string, node: SyntaxNode, write: boolean, tags: string[]) => {
    collector.declareField(name);
    const id = fields.get(name.replace(/^this\./, ""));
    if (id) collector.setFieldDefinition(name, { line: id.startPosition.row + 1, col: id.startPosition.column + 1, endCol: id.endPosition.column + 1, snippet: oneLine(id.parent?.parent?.text ?? id.text), where: "class" });
    collector.occur(name, node, write ? "write" : "read", tags);
  };
  walk(def.childForFieldName("body") ?? def, (n) => {
    if (nested(n)) return false;
    if (n.type !== "identifier" && n.type !== "field_access") return;
    if (declared.has(n.startIndex)) return;
    if (n.parent?.type === "method_invocation" && n.parent.childForFieldName("name")?.id === n.id) return;
    const write = !!inFieldOf(n, ["assignment_expression"], "left", def) || n.parent?.type === "update_expression";
    const tags: string[] = [];
    if (inFieldOf(n, ["if_statement", "for_statement", "while_statement"], "condition", def)) tags.push("condition");
    let p = n.parent; while (p && p.id !== def.id) { if (p.type === "return_statement") { tags.push("returned"); break; } p = p.parent; }
    if (n.type === "field_access") { if (n.childForFieldName("object")?.type === "this") recordField(n.text, n, write, tags); return; }
    if (n.parent?.type === "field_access" && n.parent.childForFieldName("field")?.id === n.id) return;
    if (fields.has(n.text) && !collector.isDeclared(n.text)) recordField(n.text, n, write, tags);
    else collector.occur(n.text, n, write ? "write" : "read", tags);
  });
  return collector.build(source);
}

function resolveImport(_from: string, specifier: string, index: FileIndex): ImportResolution {
  const path = specifier.replaceAll(".", "/");
  const matches = index.bySuffix(`${path}.java`).filter((p) => p === `${path}.java` || p.endsWith(`/${path}.java`));
  if (matches.length === 1) return { kind: "project", path: matches[0], guess: true };
  if (matches.length > 1) return { kind: "unresolved", reason: `多个源码根目录包含 ${specifier}，无法确定编译范围` };
  const packages = index.bySuffix(".java").filter((p) => { const dir = p.slice(0, p.lastIndexOf("/")); return dir === path || dir.endsWith(`/${path}`); }).sort();
  if (packages.length) return { kind: "project", path: packages[0], guess: true };
  return { kind: "external" };
}

export const javaPlugin: LanguagePlugin = {
  id: "java", label: "Java", extensions: [".java"], grammarFor: () => "java", isTestFile: (path) => /(?:Test|Tests|TestCase)\.java$/.test(path) || /(^|\/)src\/test\//.test(path), extract,
  flowIR: (def, source) => bracedFlow(def, source, "java"), analyzeVariables, resolveImport, joinSubmodule: (specifier, name) => `${specifier}.${name}`,
  builtinFunctions: new Set(["Object", "String", "Exception", "RuntimeException", "IllegalArgumentException", "IllegalStateException", "NullPointerException", "AssertionError"]), globalObjects: new Set(["System", "Math", "String", "Integer", "Long", "Double", "Boolean", "Objects", "Arrays", "Collections", "Thread"]),
  builtinMethods: new Set(), constructorNames: ["constructor"],
};
