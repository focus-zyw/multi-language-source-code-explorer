import type { ExtractResult, FileIndex, ImportResolution, LanguagePlugin, ParamInfo, ReceiverKind, SyntaxNode } from "../types.ts";
import { VarCollector, collectCallNames, computeMetrics, inFieldOf, oneLine, rangeOf, slice, walk, type MetricConfig } from "../util.ts";
import { bracedFlow } from "./braced-flow.ts";

const typeDeclarations = new Set(["class_declaration", "interface_declaration", "struct_declaration", "record_declaration", "enum_declaration"]);
const executableDeclarations = new Set(["method_declaration", "constructor_declaration", "local_function_statement"]);
const nested = (n: SyntaxNode) => typeDeclarations.has(n.type) || executableDeclarations.has(n.type) || n.type === "lambda_expression" || n.type === "anonymous_method_expression";
const primitives = /^(?:bool|byte|sbyte|char|decimal|double|float|int|uint|long|ulong|short|ushort|object|string|void|var|dynamic|nint|nuint)$/;
const config: MetricConfig = {
  isBranch: (n) => ["if_statement", "switch_section", "conditional_expression"].includes(n.type),
  isLoop: (n) => ["for_statement", "for_each_statement", "while_statement", "do_statement"].includes(n.type),
  isHandler: (n) => n.type === "catch_clause", isReturn: (n) => n.type === "return_statement", isThrow: (n) => n.type === "throw_statement",
  isAwait: (n) => n.type === "await_expression", isYield: () => false,
  isBoolOp: (n) => n.type === "binary_expression" && ["&&", "||"].includes(n.childForFieldName("operator")?.text ?? ""), isNestedDef: nested,
};
const simpleType = (text: string) => text.replace(/<[\s\S]*>/g, "").replace(/\[\]|\?/g, "").trim().split(".").at(-1) ?? "";
const identifierOf = (node: SyntaxNode | null) => node?.type === "identifier" ? node : node?.namedChildren.find((child) => child.type === "identifier") ?? null;

function parameters(def: SyntaxNode, source: string): { node: SyntaxNode; info: ParamInfo }[] {
  return (def.childForFieldName("parameters")?.namedChildren ?? []).filter((node) => node.type === "parameter").flatMap((node) => {
    const name = node.childForFieldName("name");
    if (!name || name.type !== "identifier") return [];
    const type = node.childForFieldName("type");
    const fallback = node.namedChildren.find((child) => child.type === "equals_value_clause")?.text.replace(/^=\s*/, "").trim();
    return [{ node: name, info: { name: name.text, display: oneLine(slice(source, node), 100), type: type?.text ?? null, defaultValue: fallback || null } }];
  });
}
function attributes(def: SyntaxNode): string[] {
  return def.namedChildren.filter((node) => node.type === "attribute_list").flatMap((list) => list.namedChildren.filter((node) => node.type === "attribute").map((node) => oneLine(`[${node.text}]`, 120)));
}
function doc(def: SyntaxNode): string | null {
  const parts: string[] = [];
  let previous = def.previousNamedSibling;
  let row = def.startPosition.row;
  while (previous?.type === "comment" && previous.endPosition.row >= row - 1) {
    parts.unshift(previous.text);
    row = previous.startPosition.row;
    previous = previous.previousNamedSibling;
  }
  const text = parts.join("\n").replace(/^\/\*\*?|\*\/$/g, "").split("\n").map((line) => line.replace(/^\s*\*\s?|^\s*\/\/\/?\s?/, "")).join("\n").replace(/<\/?summary>/gi, "").trim();
  return text || null;
}
function bodyOf(def: SyntaxNode): SyntaxNode | null {
  return def.childForFieldName("body") ?? def.namedChildren.find((node) => node.type === "arrow_expression_clause") ?? null;
}
function namespaceName(root: SyntaxNode): string {
  for (const node of root.namedChildren) {
    if (node.type !== "file_scoped_namespace_declaration" && node.type !== "namespace_declaration") continue;
    return node.childForFieldName("name")?.text ?? node.namedChildren.find((child) => child.type === "identifier" || child.type === "qualified_name")?.text ?? "";
  }
  return "";
}
function receiverKind(receiver: string | null, node: SyntaxNode | null): ReceiverKind | null {
  if (!receiver || !node) return null;
  if (node.type === "this_expression" || receiver === "this") return "self";
  if (node.type === "base_expression" || receiver === "base") return "super";
  return /^[\w$.]+$/.test(receiver) ? "name" : "expr";
}

function extract(root: SyntaxNode, source: string, path: string): ExtractResult {
  const result: ExtractResult = { symbols: [], calls: [], imports: [], hints: [], defaultExportName: null, hasSyntaxErrors: root.hasError, moduleName: namespaceName(root) };
  const hint = (owner: number | null, classId: number | null, variable: string, type: string, field = false, sourceKind: "annotation" | "constructor" = "annotation") => {
    const name = simpleType(type);
    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) && !primitives.test(name)) result.hints.push({ ownerLocalId: owner, classLocalId: classId, variable, typeName: name, source: sourceKind, field });
  };
  walk(root, (node) => {
    if (node.type !== "using_directive") return;
    const alias = node.namedChildren.find((child) => child.type === "name_equals");
    const target = node.namedChildren.find((child) => child.type !== "name_equals" && ["identifier", "qualified_name", "alias_qualified_name"].includes(child.type));
    if (!target) return;
    const specifier = target.text;
    const line = node.startPosition.row + 1;
    const isStatic = /^\s*(?:global\s+)?using\s+static\b/.test(node.text);
    if (alias) {
      const local = alias.text.replace(/\s*=.*$/, "").trim();
      const imported = specifier.split(".").at(-1);
      if (local && imported) result.imports.push({ local, localPath: local, specifier, imported, reexport: false, line });
      return;
    }
    // *static 仍走通配查找，但不把类型名当成命名空间导入。
    result.imports.push({ local: "*", localPath: isStatic ? "*static" : "*", specifier, imported: "*wildcard", reexport: false, line });
  });
  const visit = (node: SyntaxNode, scope: number | null, classId: number | null) => {
    if (node.type === "namespace_declaration" || node.type === "file_scoped_namespace_declaration" || node.type === "declaration_list") {
      for (const child of node.namedChildren) visit(child, scope, classId);
      return;
    }
    if (typeDeclarations.has(node.type)) {
      const name = node.childForFieldName("name") ?? identifierOf(node);
      const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child.type === "declaration_list" || child.type === "enum_member_declaration_list");
      if (!name || name.type !== "identifier" || !body) return;
      const localId = result.symbols.length;
      const parentName = classId !== null ? result.symbols[classId].qualifiedName : null;
      const bases = (node.childForFieldName("bases")?.namedChildren ?? []).filter((child) => ["identifier", "generic_name", "qualified_name", "alias_qualified_name", "predefined_type", "nullable_type"].includes(child.type)).map((child) => child.text);
      const members = body.type === "declaration_list" ? body : null;
      result.symbols.push({ localId, parentLocalId: scope, classLocalId: classId, kind: "class", name: name.text, qualifiedName: parentName ? `${parentName}.${name.text}` : name.text, container: null,
        isAsync: false, isGenerator: false, isTest: false, isDefaultExport: false, signature: oneLine(source.slice(node.startIndex, body.startIndex), 200), params: [], decorators: attributes(node), docstring: doc(node), returnType: null, bases,
        ...rangeOf(node), defStartIndex: node.startIndex, defEndIndex: node.endIndex, metrics: computeMetrics(node, config, 0).metrics });
      for (const field of members?.namedChildren.filter((child) => child.type === "field_declaration") ?? []) {
        const type = field.namedChildren.find((child) => child.type === "variable_declaration")?.childForFieldName("type");
        if (!type) continue;
        for (const declarator of field.namedChildren.find((child) => child.type === "variable_declaration")?.namedChildren.filter((child) => child.type === "variable_declarator") ?? []) {
          const id = identifierOf(declarator);
          if (id) hint(null, localId, id.text, type.text, true);
        }
      }
      for (const child of members?.namedChildren ?? []) visit(child, localId, localId);
      return;
    }
    if (!executableDeclarations.has(node.type)) {
      for (const child of node.namedChildren) visit(child, scope, classId);
      return;
    }
    const body = bodyOf(node);
    const name = node.childForFieldName("name");
    const localFunction = node.type === "local_function_statement";
    if (!body || !name || (!localFunction && classId === null)) return;
    const ownerClass = classId === null ? null : result.symbols[classId];
    const constructor = node.type === "constructor_declaration";
    const decorators = attributes(node);
    const isTest = !constructor && !localFunction && decorators.some((value) => /^\[(?:[\w.]+\.)?(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)\b/.test(value));
    const defs = parameters(node, source);
    const localId = result.symbols.length;
    const isAsync = node.children.some((child) => child.type === "async" || child.text === "async");
    const ownerName = scope !== null ? result.symbols[scope].qualifiedName : ownerClass?.qualifiedName;
    result.symbols.push({ localId, parentLocalId: scope, classLocalId: classId, kind: localFunction ? "function" : isTest ? "test" : "method", name: constructor ? "constructor" : name.text,
      qualifiedName: ownerName ? `${ownerName}.${name.text}` : name.text, container: localFunction ? null : ownerClass?.name ?? null, isAsync, isGenerator: false, isTest, isDefaultExport: false,
      signature: oneLine(source.slice(node.startIndex, body.startIndex), 200), params: defs.map((item) => item.info), decorators, docstring: doc(node), returnType: node.childForFieldName("type")?.text ?? null, bases: [],
      ...rangeOf(node), defStartIndex: node.startIndex, defEndIndex: node.endIndex, metrics: computeMetrics(node, config, defs.length).metrics });
    for (const item of defs) if (item.info.type) hint(localId, classId, item.info.name, item.info.type);
    walk(body, (current) => {
      if (current.id !== body.id && current.type === "local_function_statement") { visit(current, localId, classId); return false; }
      if (current.id !== body.id && nested(current)) return false;
      if (current.type === "variable_declaration" && ["local_declaration_statement", "for_statement", "using_statement"].includes(current.parent?.type ?? "")) {
        const type = current.childForFieldName("type");
        for (const declarator of current.namedChildren.filter((child) => child.type === "variable_declarator")) {
          const id = identifierOf(declarator);
          const created = declarator.namedChildren.find((child) => child.type === "equals_value_clause")?.namedChildren.find((child) => child.type === "object_creation_expression");
          if (!id) continue;
          if (type && type.type !== "implicit_type") hint(localId, classId, id.text, type.text);
          else if (created) hint(localId, classId, id.text, created.childForFieldName("type")?.text ?? "", false, "constructor");
        }
      }
      const creation = current.type === "object_creation_expression";
      if (!creation && current.type !== "invocation_expression") return;
      const target = creation ? current.childForFieldName("type") : current.childForFieldName("function");
      if (!target) return;
      const member = target.type === "member_access_expression";
      const called = member ? target.childForFieldName("name") : target;
      const receiverNode = member ? target.childForFieldName("expression") : null;
      const calledName = called ? simpleType(called.text) : null;
      if (!calledName) return;
      const receiver = receiverNode?.text ?? null;
      result.calls.push({ ownerLocalId: localId, kind: creation ? "new" : "call", name: calledName, receiver, receiverKind: receiverKind(receiver, receiverNode),
        calleeText: creation ? `new ${target.text}` : receiver ? `${receiver}.${calledName}` : called?.text ?? calledName,
        line: (receiverNode ?? called ?? target).startPosition.row + 1, col: (receiverNode ?? called ?? target).startPosition.column + 1, endLine: (called ?? target).endPosition.row + 1, endCol: (called ?? target).endPosition.column + 1 });
    });
  };
  for (const node of root.namedChildren) visit(node, null, null);
  return result;
}

function analyzeVariables(def: SyntaxNode, source: string) {
  const collector = new VarCollector();
  const declared = new Set<number>();
  const declare = (node: SyntaxNode, kind: "param" | "local" | "loop" | "catch", type: string | null = null) => {
    collector.declare(node.text, node, { kind, typeText: type, snippet: oneLine(node.parent?.text ?? node.text, 100) });
    declared.add(node.startIndex);
  };
  for (const item of parameters(def, source)) declare(item.node, "param", item.info.type);
  walk(def, (node) => {
    if (node.id !== def.id && nested(node)) return false;
    if (node.type === "variable_declaration" && ["local_declaration_statement", "for_statement", "using_statement"].includes(node.parent?.type ?? "")) {
      const type = node.childForFieldName("type");
      const typeText = type && type.type !== "implicit_type" ? type.text : null;
      for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const id = identifierOf(declarator);
        if (id) declare(id, node.parent?.type === "for_statement" ? "loop" : "local", typeText);
      }
    }
    if (node.type === "for_each_statement") {
      const id = node.childForFieldName("left");
      const type = node.childForFieldName("type");
      if (id?.type === "identifier") declare(id, "loop", type && type.type !== "implicit_type" ? type.text : null);
    }
    if (node.type === "catch_declaration") {
      const id = node.childForFieldName("name");
      if (id?.type === "identifier") declare(id, "catch", node.childForFieldName("type")?.text ?? null);
    }
  });
  let owner = def.parent;
  while (owner && !typeDeclarations.has(owner.type)) owner = owner.parent;
  const fields = new Map<string, SyntaxNode>();
  const members = owner?.childForFieldName("body");
  for (const field of members?.namedChildren.filter((node) => node.type === "field_declaration") ?? []) {
    for (const declarator of field.namedChildren.find((node) => node.type === "variable_declaration")?.namedChildren.filter((node) => node.type === "variable_declarator") ?? []) {
      const id = identifierOf(declarator);
      if (id) fields.set(id.text, id);
    }
  }
  const recordField = (name: string, node: SyntaxNode, write: boolean, tags: string[]) => {
    collector.declareField(name);
    const id = fields.get(name.replace(/^this\./, ""));
    if (id) collector.setFieldDefinition(name, { line: id.startPosition.row + 1, col: id.startPosition.column + 1, endCol: id.endPosition.column + 1, snippet: oneLine(id.parent?.parent?.text ?? id.text), where: "class" });
    collector.occur(name, node, write ? "write" : "read", tags);
  };
  const usageRoot = bodyOf(def) ?? def;
  walk(usageRoot, (node) => {
    if (node.id !== usageRoot.id && nested(node)) return false;
    if (node.type === "member_access_expression") {
      const object = node.childForFieldName("expression");
      if (object?.type !== "this_expression") return;
      const write = !!inFieldOf(node, ["assignment_expression"], "left", def);
      const tags: string[] = [];
      if (inFieldOf(node, ["if_statement", "for_statement", "while_statement"], "condition", def)) tags.push("condition");
      let parent = node.parent;
      while (parent && parent.id !== def.id) { if (parent.type === "return_statement") { tags.push("returned"); break; } parent = parent.parent; }
      recordField(node.text, node, write, tags);
      return false;
    }
    if (node.type !== "identifier" || declared.has(node.startIndex)) return;
    if (node.parent?.type === "invocation_expression" && node.parent.childForFieldName("function")?.id === node.id) return;
    if (node.parent?.type === "member_access_expression" && node.parent.childForFieldName("name")?.id === node.id) return;
    const unary = node.parent && ["postfix_unary_expression", "prefix_unary_expression"].includes(node.parent.type) ? node.parent.text : "";
    const write = !!inFieldOf(node, ["assignment_expression"], "left", def) || /(\+\+|--)/.test(unary);
    const tags: string[] = [];
    if (inFieldOf(node, ["if_statement", "for_statement", "while_statement"], "condition", def) || inFieldOf(node, ["for_each_statement"], "right", def)) tags.push("condition");
    let parent = node.parent;
    while (parent && parent.id !== def.id) { if (parent.type === "return_statement") { tags.push("returned"); break; } parent = parent.parent; }
    if (fields.has(node.text) && !collector.isDeclared(node.text)) recordField(node.text, node, write, tags);
    else collector.occur(node.text, node, write ? "write" : "read", tags);
  });
  return collector.build(source);
}

function flowIR(def: SyntaxNode, source: string) {
  const arrow = def.childForFieldName("body") ? null : def.namedChildren.find((node) => node.type === "arrow_expression_clause");
  if (!arrow) return bracedFlow(def, source, "csharp");
  return [{ t: "return" as const, startLine: arrow.startPosition.row + 1, endLine: arrow.endPosition.row + 1, label: oneLine(slice(source, arrow), 100), calls: collectCallNames([arrow], source, { invocation_expression: "function", object_creation_expression: "type" }, nested) }];
}

function resolveImport(_from: string, specifier: string, index: FileIndex): ImportResolution {
  const path = specifier.replaceAll(".", "/");
  const matches = index.bySuffix(`${path}.cs`).filter((file) => file === `${path}.cs` || file.endsWith(`/${path}.cs`));
  if (matches.length === 1) return { kind: "project", path: matches[0], guess: true };
  if (matches.length > 1) return { kind: "unresolved", reason: `多个源码路径匹配 ${specifier}，无法确定编译范围` };
  const files = index.bySuffix(".cs").filter((file) => { const dir = file.slice(0, file.lastIndexOf("/")); return dir === path || dir.endsWith(`/${path}`); }).sort();
  if (files.length === 1) return { kind: "project", path: files[0], guess: true };
  if (files.length > 1) return { kind: "unresolved", reason: `${specifier} 对应多个源码文件，改为按命名空间中的类型名查找` };
  return { kind: "external" };
}

export const csharpPlugin: LanguagePlugin = {
  id: "csharp", label: "C#", extensions: [".cs"], grammarFor: () => "c_sharp",
  isTestFile: (path) => /(?:Test|Tests)\.cs$/i.test(path.replaceAll("\\", "/")) || /(^|\/)tests?\//i.test(path.replaceAll("\\", "/")),
  extract, flowIR, analyzeVariables, resolveImport, joinSubmodule: (specifier, name) => `${specifier}.${name}`,
  builtinFunctions: new Set(["Object", "String", "Exception", "ArgumentException", "ArgumentNullException", "InvalidOperationException", "NotImplementedException", "NotSupportedException", "Task", "List", "Dictionary", "HashSet"]),
  globalObjects: new Set(["Console", "Math", "String", "Convert", "Task", "Enumerable", "File", "Directory", "Path", "Environment", "Debug", "DateTime", "Guid", "Array", "Activator", "Object"]),
  builtinMethods: new Set(), constructorNames: ["constructor"],
};
