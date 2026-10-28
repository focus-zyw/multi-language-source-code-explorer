import type { Root } from "mdast";

/** Preview-only normalization. Never rewrites saved notes, code fences or code spans. */
export function normalizeFileNoteMath(input: string): string {
  const output: string[] = [], buffer: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (!buffer.length) return;
    output.push(buffer.join("\n").replace(/(`+)[\s\S]*?\1|\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$|(?<!\\)\\{1,2}\[([\s\S]*?)\\{1,2}\]|(?<!\\)\\{1,2}\(([\s\S]*?)\\{1,2}\)/g,
      (match, code, display, inline) => code || match.startsWith("$") ? match : display !== undefined ? `\n\n$$\n${display.trim()}\n$$\n\n` : `$${inline.trim()}$`));
    buffer.length = 0;
  };
  for (const line of input.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      output.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      flush(); output.push(line); fence = { char: marker[1][0], length: marker[1].length };
    } else buffer.push(line);
  }
  flush();
  return output.join("\n");
}

function paragraphText(node: Root["children"][number] | undefined): string | null {
  return node?.type === "paragraph" && node.children.every((child) => child.type === "text")
    ? node.children.map((child) => "value" in child ? child.value : "").join("").trim() : null;
}

/** Recognize copied favicon + site name + count without inventing missing sources. */
export function remarkFileNoteCitations() {
  return (root: Root) => {
    const visit = (nodes: Root["children"]) => {
    for (let index = 0; index < nodes.length; index++) {
      const paragraph = nodes[index];
      if (paragraph.type !== "paragraph" || paragraph.children.length !== 1) continue;
      const link = paragraph.children[0];
      if (link.type !== "link" || link.children.length !== 1 || link.children[0].type !== "text" || link.children[0].value.toLowerCase() !== "image") continue;
      const citation = faviconCitation(link.url);
      if (!citation) continue;
      const caption = paragraphText(nodes[index + 1]);
      const hasCaption = caption !== null && caption.length > 0 && caption.length <= 200 && !/^\+\d+$/.test(caption);
      const countText = paragraphText(nodes[index + (hasCaption ? 2 : 1)]);
      const count = countText && /^\+\d{1,3}$/.test(countText) ? countText : "";
      const title = hasCaption ? caption : citation.title;
      link.url = citation.href;
      link.children = [{ type: "text", value: title }];
      link.data = { ...link.data, hProperties: { "data-citation-icon": citation.icon, "data-citation-title": title, "data-citation-count": count } };
      nodes.splice(index + 1, (hasCaption ? 1 : 0) + (count ? 1 : 0));
    }
    for (const node of nodes) if ("children" in node) visit(node.children as Root["children"]);
    };
    visit(root.children);
  };
}

export function faviconCitation(raw: string) {
  try {
    const icon = new URL(raw.replace(/\\&/g, "&"));
    if (icon.protocol !== "https:" || icon.username || icon.password || !(/favicon/i.test(icon.pathname))) return null;
    const domain = icon.searchParams.get("domain") || icon.searchParams.get("domain_url");
    const target = domain ? new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`) : new URL(icon.origin);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return null;
    return { icon: icon.href, href: target.href, title: target.hostname };
  } catch { return null; }
}

export function codeLanguage(code: string, declared = ""): string {
  // Some copied snippets label Python as shell/C#. Only override with Python-specific evidence.
  if (["shell", "sh", "bash", "csharp", "cs"].includes(declared.toLowerCase()) && /\b(?:if|while|for|def)\s+[^\n{};]*:\s*/.test(code)
    && /\b(?:Grounds|Entities)\.|\b(?:get_ground_type|can_harvest|plant)\(|\b(?:True|False|and|not)\b/.test(code)) return "python";
  if (declared) return declared.toLowerCase();
  if (/\bdef\s+\w+\s*\(|\bfor\s+\w+\s+in\s+|\bif\s+.+?:\s*(?:return|break)/.test(code)) return "python";
  return "text";
}

/** Optional, explicitly requested reading aid; indentation after lost boundaries is uncertain. */
export function recoverPythonLines(code: string): string {
  if (code.split("\n").filter((line) => line.trim()).length > 2) return code;
  const strings: string[] = [];
  const masked = code.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (text) => { strings.push(text); return `\u0000${strings.length - 1}\u0000`; });
  return masked.replace(/(\S)([ \t]{4,})(?=\S)/g, "$1\n$2")
    .replace(/([^\sA-Za-z_])(?=#|def\s+\w+\(|class\s+\w+|if\s+|elif\s+|for\s+|return\s+|break\b|continue\b)/g, "$1\n")
    .replace(/([)\]\d])(?=[A-Za-z_]\w*\s*(?:\+=|-=|=(?!=)))/g, "$1\n")
    .replace(/\u0000(\d+)\u0000/g, (_all, index) => strings[Number(index)]);
}
