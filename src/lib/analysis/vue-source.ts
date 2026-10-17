import type Parser from "web-tree-sitter";
import type { SyntaxNode } from "./types.ts";

export interface VueBinding {
  kind: "handler" | "component";
  text: string;
  name: string;
  startIndex: number;
  endIndex: number;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}
export interface VueSourceInfo { scriptSource: string; grammar: string; hasSyntaxErrors: boolean; warnings: string[]; bindings: VueBinding[] }
const shared = globalThis as typeof globalThis & { __codeAtlasVueSources?: WeakMap<Parser.Tree, VueSourceInfo> };
const metadata = shared.__codeAtlasVueSources ??= new WeakMap();
export const setVueSourceInfo = (tree: Parser.Tree, info: VueSourceInfo) => metadata.set(tree, info);
export const getVueSourceInfo = (root: SyntaxNode) => metadata.get(root.tree);

/** Keep UTF-16 offsets and newlines while masking template/style/custom blocks. */
export function inspectVueSource(root: SyntaxNode, source: string): VueSourceInfo {
  const masked = source.replace(/[^\r\n]/g, " ").split("");
  const info: VueSourceInfo = { scriptSource: "", grammar: "javascript", hasSyntaxErrors: root.hasError, warnings: [], bindings: [] };
  const scripts = root.namedChildren.filter((n) => n.type === "script_element");
  let setups = 0;
  let ordinary = 0;
  for (const script of scripts) {
    const tag = script.namedChildren.find((n) => n.type === "start_tag");
    const attrs = new Map((tag?.namedChildren.filter((n) => n.type === "attribute") ?? []).map((a) => {
      const name = a.namedChildren.find((n) => n.type === "attribute_name")?.text ?? "";
      const value = a.namedChildren.find((n) => n.type === "quoted_attribute_value")?.namedChildren.find((n) => n.type === "attribute_value")?.text ?? a.namedChildren.find((n) => n.type === "attribute_value")?.text ?? "";
      return [name, value];
    }));
    if (attrs.has("setup")) setups++; else ordinary++;
    const lang = attrs.get("lang") || "js";
    if (!["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(lang)) { info.warnings.push(`Vue script lang=${lang} 暂不支持，已跳过该脚本块`); info.hasSyntaxErrors = true; continue; }
    if (lang === "ts" || lang === "typescript") { if (info.grammar !== "tsx") info.grammar = "typescript"; }
    if (lang === "jsx" || lang === "tsx") info.grammar = "tsx";
    if (attrs.has("src")) info.warnings.push(`Vue 外置 script src=${attrs.get("src")} 不会自动加载，请同时导入对应源码文件`);
    const content = script.namedChildren.find((n) => n.type === "raw_text");
    if (content) for (let i = content.startIndex; i < content.endIndex; i++) masked[i] = source[i];
  }
  if (setups > 1 || ordinary > 1) { info.warnings.push("Vue 单文件组件包含重复的 script / script setup 块"); info.hasSyntaxErrors = true; }
  const bind = (node: SyntaxNode, kind: VueBinding["kind"], name: string) => {
    // A template alias can shadow a script binding; do not manufacture that edge.
    let ancestor = node.parent;
    while (ancestor) {
      const tag = ancestor.namedChildren.find((n) => n.type === "start_tag");
      for (const attribute of tag?.namedChildren.filter((n) => n.type === "directive_attribute") ?? []) {
        const directive = attribute.namedChildren.find((n) => n.type === "directive_name")?.text ?? "";
        if (!["v-for", "v-slot", "#"].includes(directive)) continue;
        const value = attribute.namedChildren.find((n) => n.type === "quoted_attribute_value")?.text ?? "";
        const aliases = directive === "v-for" ? value.split(/\s+(?:in|of)\s+/)[0] : value;
        const localAliases: string[] = aliases.match(/[A-Za-z_$][\w$]*/g) ?? [];
        if (localAliases.includes(name)) return;
      }
      ancestor = ancestor.parent;
    }
    info.bindings.push({ kind, text: node.text, name, startIndex: node.startIndex, endIndex: node.endIndex,
      line: node.startPosition.row + 1, col: node.startPosition.column + 1, endLine: node.endPosition.row + 1, endCol: node.endPosition.column + 1 });
  };
  const visitTemplate = (node: SyntaxNode) => {
    if (node.type === "tag_name" && node.parent?.type !== "end_tag" && /^[A-Z]|-/.test(node.text)) bind(node, "component", node.text);
    if (node.type === "directive_attribute") {
      const directive = node.namedChildren.find((n) => n.type === "directive_name")?.text;
      const value = node.namedChildren.find((n) => n.type === "quoted_attribute_value")?.namedChildren.find((n) => n.type === "attribute_value");
      if (value && (directive === "@" || directive === "v-on")) {
        const name = /^\s*([A-Za-z_$][\w$]*)\s*(?:\([\s\S]*\))?\s*$/.exec(value.text)?.[1];
        if (name) bind(value, "handler", name);
      }
    }
    if (node.type === "interpolation") {
      const value = node.namedChildren.find((n) => n.type === "raw_text");
      const name = value && /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(value.text)?.[1];
      if (value && name) bind(value, "handler", name);
    }
    for (const child of node.namedChildren) visitTemplate(child);
  };
  for (const template of root.namedChildren.filter((n) => n.type === "template_element")) visitTemplate(template);
  info.scriptSource = masked.join("");
  return info;
}
