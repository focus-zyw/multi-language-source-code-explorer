import type { IRStmt, SyntaxNode } from "../types.ts";
import { collectCallNames, oneLine, slice } from "../util.ts";

/** Shared control-flow shapes for brace-based ASTs; language-specific nodes stay explicit. */
export function bracedFlow(def: SyntaxNode, source: string, language: "go" | "java"): IRStmt[] {
  const text = (n: SyntaxNode | null) => n ? slice(source, n) : "";
  const nested = (n: SyntaxNode) => ["function_declaration", "method_declaration", "constructor_declaration", "func_literal", "lambda_expression", "class_declaration"].includes(n.type);
  const calls = (...nodes: (SyntaxNode | null)[]) => collectCallNames(nodes, source, { call_expression: "function", method_invocation: "name", object_creation_expression: "type" }, nested);
  const range = (n: SyntaxNode) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });
  const block = (n: SyntaxNode | null): IRStmt[] => !n ? [] : ["block", "constructor_body", "switch_block", "switch_block_statement_group"].includes(n.type) ? n.namedChildren.flatMap(stmt) : stmt(n);
  const stmt = (n: SyntaxNode): IRStmt[] => {
    const r = range(n);
    if (n.type === "comment" || n.type === "line_comment" || n.type === "block_comment" || nested(n)) return [];
    if (["block", "constructor_body"].includes(n.type)) return block(n);
    if (n.type === "if_statement") {
      const condition = n.childForFieldName("condition");
      const initializer = n.childForFieldName("initializer");
      return [...(initializer ? stmt(initializer) : []), { t: "if", ...r, cond: oneLine(text(condition), 100), calls: calls(condition), then: block(n.childForFieldName("consequence")), else: block(n.childForFieldName("alternative")) }];
    }
    if (["for_statement", "enhanced_for_statement", "while_statement", "do_statement"].includes(n.type)) {
      const body = n.childForFieldName("body");
      const condition = n.childForFieldName("condition") ?? n.namedChildren.find((c) => ["for_clause", "range_clause"].includes(c.type)) ?? null;
      return [{ t: "loop", ...r, kind: n.type === "do_statement" ? "do" : n.type === "while_statement" ? "while" : "for", cond: oneLine(condition ? text(condition) : source.slice(n.startIndex, body?.startIndex ?? n.endIndex), 100), calls: calls(condition), body: block(body), orElse: [] }];
    }
    if (["expression_switch_statement", "type_switch_statement", "select_statement"].includes(n.type)) {
      const value = n.childForFieldName("value");
      const cases = n.namedChildren.filter((c) => ["expression_case", "type_case", "communication_case", "default_case"].includes(c.type)).map((c) => {
        const labelEnd = c.children.find((x) => x.type === ":")?.startIndex ?? c.startIndex;
        return { ...range(c), label: oneLine(source.slice(c.startIndex, labelEnd), 100), isDefault: c.type === "default_case", body: c.namedChildren.filter((x) => x.startIndex > labelEnd).flatMap(stmt) };
      });
      return [{ t: "switch", ...r, disc: n.type === "select_statement" ? "select（通道选择）" : oneLine(text(value), 100), calls: calls(value), fallthrough: false, cases }];
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
