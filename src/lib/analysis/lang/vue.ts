import type { ExtractedCall, ExtractedSymbol, LanguagePlugin, ParamInfo, SyntaxNode } from "../types.ts";
import { computeMetrics, oneLine, rangeOf, slice, walk, type MetricConfig } from "../util.ts";
import { getVueSourceInfo } from "../vue-source.ts";
import { typescriptPlugin } from "./javascript.ts";

const nested = (n: SyntaxNode) => ["function_declaration", "function_expression", "function", "arrow_function", "generator_function_declaration", "method_definition", "class_declaration"].includes(n.type);
const config: MetricConfig = {
  isBranch: (n) => ["if_statement", "switch_case", "ternary_expression"].includes(n.type),
  isLoop: (n) => ["for_statement", "for_in_statement", "while_statement", "do_statement"].includes(n.type),
  isHandler: (n) => n.type === "catch_clause", isReturn: (n) => n.type === "return_statement", isThrow: (n) => n.type === "throw_statement",
  isAwait: (n) => n.type === "await_expression", isYield: (n) => n.type === "yield_expression",
  isBoolOp: (n) => n.type === "binary_expression" && ["&&", "||", "??"].includes(n.childForFieldName("operator")?.text ?? ""), isNestedDef: nested,
};

function extract(root: SyntaxNode, source: string, path: string) {
  const info = getVueSourceInfo(root);
  const result = typescriptPlugin.extract(root, source, path);
  const componentName = path.split("/").at(-1)!.replace(/\.vue$/i, "");
  for (const symbol of result.symbols) {
    symbol.localId++;
    symbol.parentLocalId = symbol.parentLocalId === null ? 0 : symbol.parentLocalId + 1;
    if (symbol.classLocalId !== null) symbol.classLocalId++;
    symbol.isDefaultExport = false;
  }
  for (const call of result.calls) call.ownerLocalId++;
  for (const hint of result.hints) { hint.ownerLocalId = hint.ownerLocalId === null ? 0 : hint.ownerLocalId + 1; if (hint.classLocalId !== null) hint.classLocalId++; }
  const lines = source.split("\n");
  result.symbols.unshift({ localId: 0, parentLocalId: null, classLocalId: null, kind: "function", name: componentName, qualifiedName: componentName, container: null,
    isAsync: false, isGenerator: false, isTest: false, isDefaultExport: true, signature: `Vue component ${componentName}`, params: [], decorators: [],
    docstring: "Vue 单文件组件入口。调用关系包含脚本初始化和模板静态绑定，不表示渲染执行顺序。", returnType: "Vue component", bases: [],
    startIndex: 0, endIndex: source.length, startLine: 1, startCol: 1, endLine: lines.length, endCol: (lines.at(-1)?.length ?? 0) + 1, defStartIndex: root.startIndex, defEndIndex: root.endIndex,
    metrics: computeMetrics(root, config, 0).metrics });
  result.defaultExportName = componentName;
  result.hasSyntaxErrors ||= info?.hasSyntaxErrors ?? false;
  result.warnings = info?.warnings ?? [];

  const recordCalls = (body: SyntaxNode, owner: number) => walk(body, (n) => {
    if (n.id !== body.id && nested(n)) return false;
    if (n.type !== "call_expression" && n.type !== "new_expression") return;
    const callee = n.childForFieldName(n.type === "new_expression" ? "constructor" : "function");
    if (!callee) return;
    const object = callee.type === "member_expression" ? callee.childForFieldName("object") : null;
    const name = callee.type === "identifier" ? callee : callee.type === "member_expression" ? callee.childForFieldName("property") : null;
    const self = object?.type === "this";
    result.calls.push({ ownerLocalId: owner, kind: n.type === "new_expression" ? "new" : "call", name: name?.text ?? null, receiver: self ? componentName : object?.text ?? null,
      receiverKind: self ? "name" : object ? /^[\w$.]+$/.test(object.text) ? "name" : "expr" : null,
      calleeText: oneLine(callee.text, 100), line: (name ?? callee).startPosition.row + 1, col: (name ?? callee).startPosition.column + 1, endLine: (name ?? callee).endPosition.row + 1, endCol: (name ?? callee).endPosition.column + 1,
      ...(self ? { origin: "vue-options" as const } : {}) });
  });
  // Existing JS extraction owns declared functions. Capture initialization calls
  // separately so script-setup statements have their own component entry.
  for (const child of root.namedChildren) { if (!nested(child)) recordCalls(child, 0); }

  const knownDefinitions = new Set(result.symbols.slice(1).map((s) => s.defStartIndex));
  walk(root, (node) => {
    if (node.type !== "program" && knownDefinitions.has(node.startIndex)) return false;
    const body = node.childForFieldName("body");
    if (!body) return;
    const method = node.type === "method_definition";
    const pairFunction = ["function_expression", "function", "arrow_function"].includes(node.type) && node.parent?.type === "pair";
    if (!method && !pairFunction) return nested(node) ? false : undefined;
    const nameNode = method ? node.childForFieldName("name") : node.parent?.childForFieldName("key");
    if (!nameNode) return;
    const name = nameNode.text.replace(/^["']|["']$/g, "");
    const outer = method ? node : node.parent!;
    const parameters: ParamInfo[] = (node.childForFieldName("parameters")?.namedChildren ?? []).map((p) => ({ name: p.childForFieldName("pattern")?.text ?? p.childForFieldName("name")?.text ?? p.text, display: oneLine(p.text, 100), type: p.childForFieldName("type")?.text.replace(/^:\s*/, "") ?? null, defaultValue: p.childForFieldName("value")?.text ?? null }));
    const symbol: ExtractedSymbol = { localId: result.symbols.length, parentLocalId: 0, classLocalId: null, kind: "method", name, qualifiedName: `${componentName}.${name}`, container: componentName,
      isAsync: node.children.some((c) => c.type === "async"), isGenerator: false, isTest: false, isDefaultExport: false, signature: oneLine(source.slice(outer.startIndex, body.startIndex), 200), params: parameters, decorators: [], docstring: null,
      returnType: node.childForFieldName("return_type")?.text ?? null, bases: [], ...rangeOf(outer), defStartIndex: node.startIndex, defEndIndex: node.endIndex, metrics: computeMetrics(node, config, parameters.length).metrics };
    result.symbols.push(symbol);
    knownDefinitions.add(node.startIndex);
    recordCalls(body, symbol.localId);
    return false;
  });
  const topLevel = result.symbols.filter((s) => s.parentLocalId === 0 && s.kind !== "class");
  for (const binding of info?.bindings ?? []) {
    let name = binding.name;
    let receiver: string | null = null;
    if (binding.kind === "component") {
      const imported = result.imports.find((b) => b.local === name || b.local.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase() === name.toLowerCase());
      if (!imported) continue;
      name = imported.local;
    } else {
      const matches = topLevel.filter((s) => s.name === name);
      if (matches.length !== 1 && !result.imports.some((b) => b.local === name)) continue;
      if (matches[0]?.container === componentName) receiver = componentName;
    }
    const call: ExtractedCall = { ownerLocalId: 0, kind: binding.kind === "component" ? "jsx" : "call", name, receiver, receiverKind: receiver ? "name" : null,
      calleeText: binding.kind === "component" ? `<${binding.text}>` : `模板绑定 ${binding.text}`, line: binding.line, col: binding.col, endLine: binding.endLine, endCol: binding.endCol, origin: "vue-template" };
    result.calls.push(call);
  }
  return result;
}

export const vuePlugin: LanguagePlugin = {
  ...typescriptPlugin, id: "vue", label: "Vue", extensions: [".vue"], grammarFor: () => "vue", isTestFile: () => false, extract,
  analysisNotes: ["Vue 仅分析内联 JS/TS 脚本；模板边为静态绑定关系，不表示挂载、点击或渲染顺序。编译宏、自动注册、动态组件与模板作用域不做运行时推导。"],
  builtinFunctions: new Set([...typescriptPlugin.builtinFunctions, "defineProps", "defineEmits", "defineExpose", "defineOptions", "defineSlots", "defineModel", "withDefaults"]),
};
