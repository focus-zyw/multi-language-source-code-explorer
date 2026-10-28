import { captureNoteLayout, encodeNoteLayout, notePasteWarning, safeNoteImage } from "./file-note-rich.ts";

/** Prefer intact Markdown, but do not discard layout HTML beside flattened plain text. */
export function fileNoteClipboard(data: Pick<DataTransfer, "getData">): string {
  const plain = data.getData("text/plain");
  const html = data.getData("text/html");
  if (!html) return plain;
  const hasLayout = /display\s*:\s*(?:inline-)?(?:grid|flex)\b|grid-template-columns|class=["'][^"']*\b(?:grid|flex)\b/i.test(html);
  const enhanced = /data-code-atlas-copy=["']1["']/i.test(html);
  if (plain && !enhanced && !hasLayout && !notePasteWarning(plain)) return plain;
  // Template content is inert: never mount clipboard HTML in the document.
  const template = document.createElement("template");
  template.innerHTML = html;
  const children = (node: Node): string => Array.from(node.childNodes, walk).reduce((out, next) =>
    /\n$/.test(out) && /^\n/.test(next) ? out.replace(/\n+$/, "\n\n") + next.replace(/^\n+/, "") : out + next, "");
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (!(node instanceof Element)) return children(node);
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "iframe", "object", "embed", "svg", "noscript"].includes(tag)) return "";
    if (node.hasAttribute("data-code-atlas-math")) {
      const source = node.textContent ?? "";
      return node.getAttribute("data-code-atlas-math") === "display" ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
    }
    if (/display\s*:\s*(?:inline-)?(?:grid|flex)\b|grid-template-columns/i.test(node.getAttribute("style") ?? "") || /\b(?:grid|flex)\b/.test(node.getAttribute("class") ?? "")) {
      const layout = captureNoteLayout(node.outerHTML);
      if (layout) return `\n\n![富文本布局](${encodeNoteLayout(layout)})\n\n`;
    }
    if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      const alt = (node.getAttribute("alt") ?? "图片").replace(/[[\]\\]/g, "\\$&");
      return safeNoteImage(src) ? `![${alt}](<${src.replace(/[<>\r\n]/g, "")}>)` : alt;
    }
    if (tag === "pre") {
      const rawCode = (part: Node): string => {
        if (part.nodeType === 3) return part.textContent ?? "";
        if (part instanceof Element && part.tagName === "BR") return "\n";
        return Array.from(part.childNodes, (child) => {
          const text = rawCode(child);
          return child instanceof Element && ["DIV", "P"].includes(child.tagName) && !text.endsWith("\n") ? `${text}\n` : text;
        }).join("");
      };
      const code = rawCode(node);
      const language = /\blanguage-([\w+-]+)/.exec(node.querySelector("code")?.getAttribute("class") ?? "")?.[1] ?? "";
      const fence = "`".repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length + 1)));
      return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
    }
    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => walk(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
      return `\n\n${line(rows[0])}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    const text = children(node);
    if (tag === "br") return "\n";
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === "strong" || tag === "b") return `**${text}**`;
    if (tag === "em" || tag === "i") return `*${text}*`;
    if (tag === "code") {
      const fence = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
      return `${fence} ${text} ${fence}`;
    }
    if (tag === "ul" || tag === "ol") {
      return "\n\n" + Array.from(node.children, (item, index) => {
        const content = children(item).trim();
        return `${tag === "ol" ? `${index + 1}.` : "-"} ${content.replace(/\n/g, "\n   ")}`;
      }).join("\n") + "\n\n";
    }
    if (tag === "blockquote") return `\n\n${text.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    if (tag === "a") {
      const href = node.getAttribute("href") ?? "";
      return /^(https?:|mailto:)/i.test(href) ? `[${text}](<${href.replace(/[<>\n\r]/g, "")}>)` : text;
    }
    if (["p", "div", "section", "article", "tr"].includes(tag)) return `\n\n${text.trim()}\n\n`;
    return text;
  };
  return walk(template.content).trim();
}
