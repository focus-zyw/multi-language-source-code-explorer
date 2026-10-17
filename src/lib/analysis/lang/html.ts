import type { ExtractResult, LanguagePlugin, SyntaxNode } from "../types.ts";
import { structureDefaults, structureSymbol } from "../structure.ts";
import { oneLine } from "../util.ts";

const ROLES: Record<string, string> = { html: "页面根元素", head: "页面元信息", title: "页面标题", body: "可见页面内容", header: "页头或区块头部", nav: "导航区", main: "主要内容", section: "内容分区", article: "独立内容", aside: "补充内容", footer: "页脚或区块尾部", form: "表单", input: "输入控件", button: "按钮", a: "超链接", img: "图像", script: "脚本资源或内联脚本（此处只浏览结构，不执行）", style: "内联样式（此处不分析 CSS）", link: "外部资源声明", div: "通用容器", p: "段落" };

function extract(root: SyntaxNode): ExtractResult {
  const symbols = [structureSymbol(root, 0, null, "HTML 文档", "$document", "HTML document", "HTML 文档结构。标签嵌套表示包含关系，不表示函数调用或执行顺序。")];
  const stack = root.namedChildren.toReversed().map((node) => ({ node, parent: 0, depth: 1 }));
  const counts = new Map<string, number>();
  let limited = false;
  while (stack.length) {
    const { node, parent, depth } = stack.pop()!;
    if (symbols.length >= 5000 || depth > 80) { limited = true; continue; }
    let owner = parent;
    if (["element", "script_element", "style_element"].includes(node.type)) {
      const tag = node.namedChildren.find((n) => n.type === "start_tag" || n.type === "self_closing_tag");
      const tagName = tag?.namedChildren.find((n) => n.type === "tag_name")?.text ?? "?";
      const attrs = tag?.namedChildren.filter((n) => n.type === "attribute") ?? [];
      const id = attrs.find((n) => n.namedChildren[0]?.text.toLowerCase() === "id")?.namedChildren[1]?.text.replace(/^["']|["']$/g, "");
      const name = `<${tagName}${id ? `#${id}` : ""}>`;
      const key = `${parent}:${tagName}`;
      const index = (counts.get(key) ?? 0) + 1;
      counts.set(key, index);
      owner = symbols.length;
      symbols.push(structureSymbol(node, owner, parent, name, `${symbols[parent].qualifiedName}/${tagName}[${index}]`, oneLine(tag?.text ?? name, 600),
        `${ROLES[tagName.toLowerCase()] ?? "HTML 元素或自定义标签"}。${attrs.length ? `属性：${attrs.map((a) => oneLine(a.text, 160)).join("；")}` : "未声明属性。"}`));
    }
    for (const child of node.namedChildren.toReversed()) {
      if (["start_tag", "end_tag", "self_closing_tag", "raw_text", "text", "comment"].includes(child.type)) continue;
      stack.push({ node: child, parent: owner, depth: depth + (owner !== parent ? 1 : 0) });
    }
  }
  return { symbols, calls: [], imports: [], hints: [], defaultExportName: null, hasSyntaxErrors: root.hasError, warnings: limited ? ["HTML 结构仅保留前 5000 个节点、最多 80 层。"] : [] };
}

export const htmlPlugin: LanguagePlugin = {
  ...structureDefaults, id: "html", label: "HTML", extensions: [".html", ".htm"], grammarFor: () => "html", extract,
  analysisNotes: ["HTML 展示标签结构与属性；不会执行脚本、渲染页面或推导事件处理函数调用。内联脚本暂不提取函数，独立 JS/TS 文件仍可正常分析。"],
};
