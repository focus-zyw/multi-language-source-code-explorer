/* The same capture engine runs in an isolated content-script world and browser tests.
   No page scripts, application state, account storage or private APIs are evaluated. */
(() => {
  if (globalThis.CodeAtlasCopy) return;
  const MAX_HTML = 2 * 1024 * 1024;
  const MAX_IMAGE = 1024 * 1024;
  const MAX_NODES = 4000;
  const allowed = new Set("div span p section article h1 h2 h3 h4 h5 h6 strong b em i small code pre br hr ul ol li blockquote table thead tbody tfoot tr th td img a".split(" "));
  const dropped = new Set("script style iframe object embed form input button textarea select link meta base noscript video audio".split(" "));
  // Must match the note importer's static-style allowlist. Position, URLs and fonts stay out.
  const properties = "display grid-template-columns grid-template-rows gap row-gap column-gap align-items justify-content flex-direction flex-wrap flex grid-column grid-row padding padding-top padding-bottom padding-left padding-right margin-top margin-bottom border-width border-style border-color border-radius background-color color font-size font-weight text-align min-height aspect-ratio white-space".split(" ");
  const encoder = new TextEncoder();
  const bytes = (value) => encoder.encode(value).length;
  const safeUrl = (value) => /^https?:\/\/[^\s<>]+$/i.test(value);
  const safeData = (value) => /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
  const visible = (element) => {
    const css = getComputedStyle(element);
    return css.display !== "none" && css.visibility !== "hidden" && !element.hidden;
  };
  function columns(value) {
    // Computed widths are pixels. Preserve unequal columns as proportional tracks.
    const tracks = value.trim().split(/\s+/);
    if (tracks.length < 2 || tracks.length > 24 || !tracks.every((track) => /^\d+(?:\.\d+)?px$/.test(track))) return "";
    const widths = tracks.map(parseFloat), max = Math.max(...widths);
    if (!max) return "";
    const proportional = widths.map((width) => `minmax(0, ${(width / max).toFixed(3)}fr)`).join(" ");
    return Math.max(...widths) - Math.min(...widths) < 2 || proportional.length >= 200
      ? `repeat(${tracks.length}, minmax(0, 1fr))` : proportional;
  }
  function isLayout(node, css) {
    const children = Array.from(node.children).filter((child) => visible(child) && !dropped.has(child.tagName.toLowerCase()));
    if (children.length < 2 || node.matches("pre,code,table,ul,ol,p,a")) return false;
    if (/grid/.test(css.display)) return Boolean(columns(css.gridTemplateColumns));
    // Generic prose uses flex too. Only rows of visually separated cards count as layouts.
    if (!/flex/.test(css.display) || !css.flexDirection.startsWith("row") || children.length > 24) return false;
    return children.every((child) => {
      if (!child.matches("div,section,article")) return false;
      const style = getComputedStyle(child);
      return parseFloat(style.borderTopWidth) > 0 || parseFloat(style.paddingTop) >= 8 || parseFloat(style.borderRadius) >= 4;
    });
  }
  function layoutStyles(node, target, css) {
    for (const property of properties) {
      const value = css.getPropertyValue(property);
      if (!value || /url|expression|var\(|attr\(/i.test(value) || value.length >= 200) continue;
      if (/^(normal|none|auto|0px|0px 0px|0px 0px 0px|start|stretch)$/.test(value)) continue;
      target.style.setProperty(property, value);
    }
    const tracks = columns(css.gridTemplateColumns);
    if (tracks) target.style.gridTemplateColumns = tracks;
    target.style.maxWidth = "100%";
    // Fixed heights and clipping do not survive narrow note panels.
    if (node.tagName === "PRE") target.style.whiteSpace = "pre-wrap";
  }
  function rawCode(node) {
    const code = node.querySelector("code") ?? node;
    const text = code.textContent ?? "";
    if (text.includes("\n")) return text;
    if (code.querySelector("br,div,p")) return code.innerText ?? text;
    return text;
  }
  function mathSource(node) {
    if (!node.matches(".katex,.katex-display,mjx-container,math,[data-math]")) return null;
    const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.getAttribute("data-math");
    const display = node.matches(".katex-display") || node.getAttribute("display") === "block" || node.getAttribute("display") === "true";
    return { source, display };
  }
  function imageData(node, report) {
    const src = node.currentSrc || node.getAttribute("src") || "";
    if (safeData(src) && bytes(src) <= MAX_IMAGE * 4 / 3 + 100) return src;
    if (!safeUrl(src)) { report.warnings.add("有图片地址无法保存，请补充截图。"); return ""; }
    try {
      if (!node.complete || !node.naturalWidth || node.naturalWidth * node.naturalHeight > 16000000) throw new Error("unavailable");
      const canvas = document.createElement("canvas");
      canvas.width = node.naturalWidth; canvas.height = node.naturalHeight;
      canvas.getContext("2d").drawImage(node, 0, 0);
      const data = canvas.toDataURL("image/png");
      if ((data.length - data.indexOf(",") - 1) * 3 / 4 > MAX_IMAGE) throw new Error("too large");
      report.localImages++;
      return data;
    } catch {
      report.warnings.add("有图片只能保留外部链接，可能失效；需要长期保存时请补充截图。");
      return src;
    }
  }
  function markdown(root) {
    const blocks = [];
    const escape = (text) => text.replace(/\\/g, "\\\\").replace(/([`*_[\]])/g, "\\$1");
    const fence = (text, min) => "`".repeat(Math.max(min, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return escape((node.textContent ?? "").replace(/\s+/g, " "));
      if (!(node instanceof Element)) return Array.from(node.childNodes, walk).join("");
      const tag = node.tagName.toLowerCase();
      if (node.hasAttribute("data-code-atlas-math")) {
        const block = node.getAttribute("data-code-atlas-math") === "display";
        return block ? `\n\n$$\n${node.textContent}\n$$\n\n` : `$${node.textContent}$`;
      }
      if (tag === "pre") {
        const text = node.textContent ?? "", token = fence(text, 3);
        const lang = node.querySelector("code")?.className.replace(/^language-/, "") ?? "";
        blocks.push(`${token}${lang}\n${text.replace(/\n$/, "")}\n${token}`);
        return `\n\n\u0000CODE${blocks.length - 1}\u0000\n\n`;
      }
      if (tag === "code") { const text = node.textContent ?? "", token = fence(text, 1); return `${token} ${text} ${token}`; }
      if (tag === "img") return `![${escape(node.getAttribute("alt") || "图片") }](<${node.getAttribute("src") ?? ""}>)`;
      if (tag === "table") {
        const rows = Array.from(node.rows, (row) => Array.from(row.cells, (cell) => Array.from(cell.childNodes, walk).join("").trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
        if (!rows.length) return "";
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
        return `\n\n${line(rows[0])}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
      }
      if (tag === "ul" || tag === "ol") return "\n\n" + Array.from(node.children, (li, index) => {
        const content = Array.from(li.childNodes, walk).join("").trim();
        return `${tag === "ol" ? `${index + 1}.` : "-"} ${content.replace(/\n/g, "\n   ")}`;
      }).join("\n") + "\n\n";
      const text = Array.from(node.childNodes, walk).join("");
      if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
      if (tag === "br") return "\n";
      if (tag === "hr") return "\n\n---\n\n";
      if (tag === "strong" || tag === "b") return `**${text}**`;
      if (tag === "em" || tag === "i") return `*${text}*`;
      if (tag === "a") return node.hasAttribute("href") ? `[${text}](<${node.getAttribute("href")}>)` : text;
      if (tag === "blockquote") return `\n\n${text.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      return /^(p|div|section|article)$/.test(tag) ? `\n\n${text.trim()}\n\n` : text;
    };
    return walk(root).trim().replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => blocks[Number(index)]);
  }
  function capture(root) {
    if (!(root instanceof Element) || !root.isConnected || root.matches("html,body,[data-code-atlas-copy-ui]")) throw new Error("请只选择一条回复或一个内容区域。");
    if (root.querySelectorAll("*").length > MAX_NODES) throw new Error("所选内容过大，请分段选择。");
    if (root.matches('[aria-busy="true"],[data-is-streaming="true"]') || root.querySelector('[aria-busy="true"],[data-is-streaming="true"]')) throw new Error("回复仍在生成，请完成后重新复制。");
    const report = { layouts: 0, codeBlocks: 0, formulas: 0, localImages: 0, warnings: new Set() };
    let count = 0;
    const clone = (node, inLayout = false, depth = 0) => {
      if (++count > MAX_NODES || depth > 32) throw new Error("所选内容层级或大小超出限制，请分段复制。");
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
      const empty = () => document.createDocumentFragment();
      if (!(node instanceof Element)) return empty();
      const tag = node.tagName.toLowerCase();
      if (dropped.has(tag) || node.hasAttribute("data-code-atlas-copy-ui") || !visible(node)) {
        if (["iframe", "video", "audio"].includes(tag)) report.warnings.add("有嵌入内容无法复制，请补充截图或链接。");
        return empty();
      }
      const math = mathSource(node);
      if (math) {
        const out = document.createElement("span");
        if (math.source) {
          out.setAttribute("data-code-atlas-math", math.display ? "display" : "inline"); out.textContent = math.source; report.formulas++;
        } else { out.textContent = "[公式无法读取，请补充截图]"; report.warnings.add("有公式缺少 LaTeX 标注，请补充截图。"); }
        return out;
      }
      if (tag === "svg" || tag === "canvas") {
        report.warnings.add("有 SVG 或 Canvas 图示需补充截图。");
        return document.createTextNode("[图示请补充截图]");
      }
      if (tag === "pre") {
        const out = document.createElement("pre"), code = document.createElement("code"), text = rawCode(node);
        const source = node.querySelector("code") ?? node;
        const language = Array.from(source.classList).find((name) => /^language-[\w+-]+$/.test(name)) || (/^[\w+-]+$/.test(node.getAttribute("data-language") ?? "") ? `language-${node.getAttribute("data-language")}` : "");
        if (language) code.className = language;
        code.textContent = text; out.append(code); report.codeBlocks++;
        if (!text.includes("\n") && text.length > 100) report.warnings.add("有较长代码块在原页面中没有换行，请检查原文。");
        if (inLayout) out.style.whiteSpace = "pre-wrap";
        return out;
      }
      const css = getComputedStyle(node), layout = !inLayout && isLayout(node, css);
      const out = document.createElement(allowed.has(tag) ? tag : "span");
      if (layout) { report.layouts++; out.setAttribute("data-code-atlas-layout", "1"); }
      if (layout || inLayout) layoutStyles(node, out, css);
      if (layout && /flex/.test(css.display) && css.flexWrap === "nowrap") out.style.flexWrap = "wrap";
      if (tag === "img") {
        const src = imageData(node, report);
        if (!src) return document.createTextNode("[图片请补充截图]");
        out.setAttribute("src", src); out.setAttribute("alt", node.getAttribute("alt") || "图片");
      }
      if (tag === "a" && safeUrl(node.href)) out.setAttribute("href", node.href);
      for (const attr of ["colspan", "rowspan"]) {
        const value = Number(node.getAttribute(attr));
        if (value > 0 && value <= 24 && Number.isInteger(value)) out.setAttribute(attr, String(value));
      }
      for (const child of node.childNodes) out.append(clone(child, inLayout || layout, depth + 1));
      if (layout && bytes(out.outerHTML) > 240 * 1024) throw new Error("图示过大，请单独截图插入，或缩小选择区域。");
      return out;
    };
    const output = document.createElement("section"); output.setAttribute("data-code-atlas-copy", "1");
    output.append(clone(root));
    const html = output.outerHTML, plain = markdown(output);
    if (!plain.trim()) throw new Error("所选区域没有可复制的内容。");
    if (bytes(html) > MAX_HTML) throw new Error("复制内容超过 2MB，请分段复制或单独插入图片。");
    // Embedded images belong in local media, never in the note's 32KB text budget.
    const textWithoutImages = plain.replace(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+/g, "图片附件");
    if (bytes(textWithoutImages) > 32768) throw new Error("正文超过文件笔记的 32KB 限制，请分段复制。");
    return { html, plain, report: { ...report, warnings: Array.from(report.warnings) } };
  }
  globalThis.CodeAtlasCopy = Object.freeze({ capture });
})();
