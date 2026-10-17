import type { ExtractResult, LanguagePlugin, SyntaxNode } from "../types.ts";
import { structureDefaults, structureSymbol } from "../structure.ts";
import { oneLine } from "../util.ts";

const PACKAGE_FIELDS: Record<string, string> = {
  name: "包名称", version: "包版本", private: "包发布限制标记", scripts: "命名脚本命令；这里只展示命令文本，不执行", dependencies: "运行依赖声明", devDependencies: "开发依赖声明", peerDependencies: "宿主应提供的依赖约束", optionalDependencies: "可选依赖声明", engines: "运行环境版本约束", exports: "包导出入口声明", main: "包入口声明", type: "JavaScript 模块类型声明", workspaces: "工作区包路径声明",
};

function describe(filePath: string, path: (string | number)[]): string {
  const base = filePath.split("/").at(-1)?.toLowerCase();
  if (base === "package.json" && typeof path[0] === "string") {
    if (path[0] === "scripts" && path.length === 2) return `package.json 的脚本 ${JSON.stringify(path[1])}；此处只展示声明，不执行命令。`;
    if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(path[0]) && path.length === 2) return `${path[0]} 中的依赖 ${JSON.stringify(path[1])}，值为声明的版本或来源；不代表已安装或实际使用。`;
    if (path.length === 1 && PACKAGE_FIELDS[path[0]]) return `按 package.json 文件约定：${PACKAGE_FIELDS[path[0]]}。`;
  }
  return "JSON 数据节点。具体业务含义需要读取该字段的代码或配置格式说明，不能仅凭键名确定。";
}

function extract(root: SyntaxNode, source: string, filePath: string): ExtractResult {
  let invalid = root.hasError;
  try { JSON.parse(source); } catch { invalid = true; }
  const warnings: string[] = invalid ? ["JSON 不符合严格语法；结构可能不完整（暂不支持 JSONC 注释或尾逗号）。"] : [];
  const symbols: ExtractResult["symbols"] = [];
  const stack: { node: SyntaxNode; range: SyntaxNode; parent: number | null; path: (string | number)[]; name: string; depth: number; suffix?: string }[] = [];
  const value = root.namedChildren.find((n) => n.type !== "comment");
  // Always provide a selectable root, even for invalid or empty files.
  stack.push({ node: value ?? root, range: root, parent: null, path: [], name: "JSON 文档", depth: 0 });
  let limited = false;
  while (stack.length) {
    const item = stack.pop()!;
    if (symbols.length >= 5000 || item.depth > 80) { limited = true; continue; }
    const { node, range, parent, path, name } = item;
    const type = ["object", "array", "string", "number", "true", "false", "null"].includes(node.type) ? ["true", "false"].includes(node.type) ? "boolean" : node.type : "invalid";
    const children = node.namedChildren.filter((n) => n.type !== "comment");
    const preview = type === "object" ? `{ ${children.filter((n) => n.type === "pair").length} 项 }` : type === "array" ? `[ ${children.length} 项 ]` : oneLine(node.text, 160);
    const qualifiedName = parent === null ? "$" : `${symbols[parent].qualifiedName}[${JSON.stringify(path.at(-1))}]${item.suffix ?? ""}`;
    const symbol = structureSymbol(range, symbols.length, parent, `${name}: ${preview}`, qualifiedName, `${qualifiedName} · ${type} · ${preview}`, `${describe(filePath, path)}\n字段路径：${qualifiedName}\n值类型：${type}\n${type === "object" || type === "array" ? "子节点表示数据包含关系。" : `当前值：${preview}`}`);
    symbol.kind = "property";
    symbols.push(symbol);
    if (type === "array") {
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], range: children[i], parent: symbol.localId, path: [...path, i], name: `[${i}]`, depth: item.depth + 1 });
    } else if (type === "object") {
      const counts = new Map<string, number>();
      const entries: typeof stack = [];
      for (const pair of children.filter((n) => n.type === "pair")) {
        const keyNode = pair.childForFieldName("key");
        const child = pair.childForFieldName("value");
        if (!keyNode || !child) continue;
        let key: string;
        try { key = JSON.parse(keyNode.text); } catch { key = keyNode.text; }
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count === 2 && warnings.length < 30) warnings.push(`发现重复键 ${oneLine(key, 80)}（第 ${pair.startPosition.row + 1} 行），保留各项，请确认消费者如何处理。`);
        entries.push({ node: child, range: pair, parent: symbol.localId, path: [...path, key], name: JSON.stringify(key), depth: item.depth + 1, suffix: count > 1 ? ` (重复 #${count})` : "" });
      }
      stack.push(...entries.reverse());
    }
  }
  if (limited) warnings.push("JSON 结构仅保留前 5000 个节点、最多 80 层。");
  return { symbols, calls: [], imports: [], hints: [], defaultExportName: null, hasSyntaxErrors: invalid, warnings };
}

export const jsonPlugin: LanguagePlugin = {
  ...structureDefaults, id: "json", label: "JSON", extensions: [".json"], grammarFor: () => "json", extract,
  analysisNotes: ["JSON 展示数据层级、路径与值类型；不是执行流程。仅支持严格 JSON，不执行配置中的命令，也不加载 $ref 或网络资源。"],
};
