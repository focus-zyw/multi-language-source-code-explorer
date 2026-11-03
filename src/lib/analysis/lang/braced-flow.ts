import type { IRStmt, SyntaxNode } from "../types.ts";
import { collectCallNames, oneLine, slice } from "../util.ts";

/** Shared control-flow shapes for brace-based ASTs; language-specific nodes stay explicit. */
export function bracedFlow(def: SyntaxNode, source: string, language: "go" | "java" | "csharp"): IRStmt[] {
  const text = (n: SyntaxNode | null) => n ? slice(source, n) : "";
  const nested = (n: SyntaxNode) => ["function_declaration", "method_declaration", "constructor_declaration", "local_function_statement", "func_literal", "lambda_expression", "anonymous_method_expression", "class_declaration", "struct_declaration", "record_declaration", "interface_declaration", "enum_declaration"].includes(n.type);
  const calls = (...nodes: (SyntaxNode | null)[]) => collectCallNames(nodes, source, { call_expression: "function", method_invocation: "name", invocation_expression: "function", object_creation_expression: "type" }, nested);
  const range = (n: SyntaxNode) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });
  const block = (n: SyntaxNode | null): IRStmt[] => !n ? [] : ["block", "constructor_body", "switch_block", "switch_block_statement_group"].includes(n.type) ? n.namedChildren.flatMap(stmt) : stmt(n);
  const stmt = (n: SyntaxNode): IRStmt[] => {
    const r = range(n);
    if (n.type === "comment" || n.type === "line_comment" || n.type === "block_comment" || nested(n)) return [];
    if (["block", "constructor_body"].includes(n.type)) return block(n);
    if (n.type === "if_statement") {
      const condition = n.childForFieldName("condition");
      const initializer = n.childForFieldName("initializer");
      const consequence = n.childForFieldName("consequence");
      const alternative = n.childForFieldName("alternative") ?? (language === "csharp" ? n.namedChildren.filter((child) => child.id !== condition?.id && child.id !== consequence?.id && child.id !== initializer?.id)[0] ?? null : null);
      return [...(initializer ? stmt(initializer) : []), { t: "if", ...r, cond: oneLine(text(condition), 100), calls: calls(condition), then: block(consequence), else: block(alternative) }];
    }
    if (language === "csharp" && ["while_statement", "do_statement", "for_each_statement"].includes(n.type)) {
      const body = n.childForFieldName("body") ?? [...n.namedChildren].reverse().find((child) => child.type === "block") ?? null;
      const headerNode = n.childForFieldName("condition") ?? n.namedChildren.find((child) => child.id !== body?.id && child.type !== "block" && child.type !== "implicit_type");
      const header = n.type === "for_each_statement" ? source.slice(n.startIndex, body?.startIndex ?? n.endIndex) : text(headerNode ?? null);
      return [{ t: "loop", ...r, kind: n.type === "do_statement" ? "do" : n.type === "while_statement" ? "while" : "for", cond: oneLine(header, 100), calls: calls(...n.namedChildren.filter((child) => child.id !== body?.id)), body: block(body), orElse: [] }];
    }
    if (language === "csharp" && n.type === "lock_statement") {
      const body = n.namedChildren.find((child) => child.type === "block") ?? null;
      return [{ t: "stmt", ...r, label: oneLine(source.slice(n.startIndex, body?.startIndex ?? n.endIndex), 100), calls: calls(...n.namedChildren.filter((child) => child.id !== body?.id)) }, ...block(body)];
    }
    if (language === "csharp" && n.type === "switch_statement") {
      const value = n.childForFieldName("value");
      const sections = (n.childForFieldName("body") ?? n.namedChildren.find((child) => child.type === "switch_body"))?.namedChildren.filter((child) => child.type === "switch_section") ?? [];
      const cases = sections.map((section) => {
        const labels = section.namedChildren.filter((child) => child.type === "case_switch_label" || child.type === "default_switch_label");
        const labelEnd = labels.at(-1)?.endIndex ?? section.startIndex;
        return { ...range(section), label: oneLine(labels.map((label) => label.text).join(" "), 100) || "case", isDefault: labels.some((label) => label.type === "default_switch_label"), body: section.namedChildren.filter((child) => child.startIndex >= labelEnd && !labels.some((label) => label.id === child.id)).flatMap(stmt) };
      });
      return [{ t: "switch", ...r, disc: oneLine(text(value), 100), calls: calls(value), fallthrough: false, cases }];
    }
    if (["for_statement", "enhanced_for_statement", "while_statement", "do_statement"].includes(n.type)) {
      const body = n.childForFieldName("body");
      const condition = n.childForFieldName("condition") ?? n.namedChildren.find((c) => ["for_clause", "range_clause"].includes(c.type)) ?? null;
      const header = n.type === "for_statement" || n.type === "enhanced_for_statement" ? source.slice(n.startIndex, body?.startIndex ?? n.endIndex) : text(condition);
      return [{ t: "loop", ...r, kind: n.type === "do_statement" ? "do" : n.type === "while_statement" ? "while" : "for", cond: oneLine(header, 100), calls: calls(...n.namedChildren.filter((child) => child.id !== body?.id)), body: block(body), orElse: [] }];
    }
    if (["expression_switch_statement", "type_switch_statement", "select_statement"].includes(n.type)) {
      const value = n.childForFieldName("value");
      const cases = n.namedChildren.filter((c) => ["expression_case", "type_case", "communication_case", "default_case"].includes(c.type)).map((c) => {
        const labelEnd = c.children.find((x) => x.type === ":")?.startIndex ?? c.startIndex;
        return { ...range(c), label: oneLine(source.slice(c.startIndex, labelEnd), 100), isDefault: c.type === "default_case", body: c.namedChildren.filter((x) => x.startIndex > labelEnd).flatMap(stmt) };
      });
      return [{ t: "switch", ...r, disc: n.type === "select_statement" ? "select（通道选择）" : oneLine(text(value), 100), calls: calls(value), fallthrough: false, cases }];
    }
    if (n.type === "switch_expression" || n.type === "switch_statement") {
      const condition = n.childForFieldName("condition");
      const cases = (n.childForFieldName("body")?.namedChildren ?? []).filter((c) => ["switch_block_statement_group", "switch_rule"].includes(c.type)).map((c) => {
        const label = c.namedChildren.find((child) => child.type === "switch_label");
        return { ...range(c), label: oneLine(text(label ?? null), 100), isDefault: label?.text === "default", body: c.namedChildren.filter((child) => child.type !== "switch_label").flatMap(stmt) };
      });
      return [{ t: "switch", ...r, disc: oneLine(text(condition), 100), calls: calls(condition), fallthrough: !(n.childForFieldName("body")?.namedChildren.some((c) => c.type === "switch_rule")), cases }];
    }
    if (n.type === "try_statement" || n.type === "try_with_resources_statement") {
      const handlers = n.namedChildren.filter((c) => c.type === "catch_clause").map((c) => ({ ...range(c), label: oneLine(source.slice(c.startIndex, c.childForFieldName("body")?.startIndex ?? c.endIndex), 100), body: block(c.childForFieldName("body")) }));
      const fin = n.namedChildren.find((c) => c.type === "finally_clause")?.namedChildren.find((c) => c.type === "block") ?? null;
      return [{ t: "try", ...r, body: block(n.childForFieldName("body")), handlers, orElse: [], finally: block(fin) }];
    }
    if (n.type === "synchronized_statement") {
      const body = n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "block") ?? null;
      return [{ t: "stmt", ...r, label: oneLine(source.slice(n.startIndex, body?.startIndex ?? n.endIndex), 100), calls: calls(n.childForFieldName("condition")) }, ...block(body)];
    }
    if (n.type === "return_statement") return [{ t: "return", ...r, label: oneLine(text(n), 100), calls: calls(n) }];
    if (n.type === "throw_statement" || (language === "go" && /^panic\s*\(/.test(text(n)))) return [{ t: "throw", ...r, label: oneLine(text(n), 100), calls: calls(n) }];
    if (n.type === "break_statement") return [{ t: "break", ...r }];
    if (n.type === "continue_statement") return [{ t: "continue", ...r }];
    if (n.type === "labeled_statement") return n.namedChildren.slice(1).flatMap(stmt);
    return [{ t: "stmt", ...r, label: oneLine(text(n), 100), calls: calls(n) }];
  };
  return block(def.childForFieldName("body"));
}
