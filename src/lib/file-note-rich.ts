import { fromHtml } from "hast-util-from-html";
import type { RootContent } from "hast";

export const NOTE_LAYOUT_MAX_BYTES = 2 * 1024 * 1024;
export const NOTE_IMAGE_MAX_BYTES = 1024 * 1024;
export const RICH_NOTE_PREFIX = "data:application/x-code-atlas-layout;base64,";
export type RichNoteNode = string | { tag: string; style: Record<string, string>; attrs: Record<string, string | number>; children: RichNoteNode[] };
const tags = new Set("div span p section article h1 h2 h3 h4 h5 h6 strong b em i small code pre br hr ul ol li blockquote table thead tbody tfoot tr th td img a".split(" "));
const dropped = new Set("script style iframe object embed form input button textarea select link meta base svg canvas video audio".split(" "));
const styles = new Set("display gridTemplateColumns gridTemplateRows gap rowGap columnGap alignItems justifyContent flexDirection flexWrap flex gridColumn gridRow padding paddingTop paddingBottom paddingLeft paddingRight margin marginTop marginBottom border borderWidth borderStyle borderColor borderRadius backgroundColor color fontSize fontWeight textAlign width maxWidth minWidth height minHeight aspectRatio whiteSpace".split(" "));

function styleValue(value: unknown): value is string {
  return typeof value === "string" && value.length < 200 && /^[\w\s#.,%()+/-]+$/.test(value) && !/url|expression|var\(|attr\(/i.test(value)
    && !Array.from(value.replace(/#[0-9a-f]{3,8}/gi, "").matchAll(/\d+(?:\.\d+)?/g)).some((match) => Number(match[0]) > 4096)
    && !Array.from(value.matchAll(/repeat\s*\(\s*(\d+)/gi)).some((match) => Number(match[1]) > 24);
}
export function safeNoteStyle(raw: string) {
  const output: Record<string, string> = {};
  for (const declaration of raw.split(";")) {
    const colon = declaration.indexOf(":"); if (colon < 0) continue;
    let key = declaration.slice(0, colon).trim().replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
    if (key === "background") key = "backgroundColor";
    const value = declaration.slice(colon + 1).trim();
    // Chromium serializes separately assigned direction/wrap as this shorthand.
    if (key === "flexFlow" && styleValue(value)) {
      for (const part of value.split(/\s+/)) {
        if (/^(?:row|column)(?:-reverse)?$/.test(part)) output.flexDirection = part;
        if (/^(?:nowrap|wrap|wrap-reverse)$/.test(part)) output.flexWrap = part;
      }
    }
    if (styles.has(key) && styleValue(value)) output[key] = value;
  }
  return output;
}
export function safeNoteImage(src: string): boolean {
  return /^https?:\/\/[^\s<>]+$/i.test(src) || /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src);
}

/** Parse inertly, keep only static content/layout, and never mount clipboard HTML. */
export function captureNoteLayout(html: string): RichNoteNode[] | null {
  if (html.length > 256 * 1024) return null;
  const root = fromHtml(html, { fragment: true });
  let count = 0, hasLayout = false;
  const walk = (node: RootContent, depth: number): RichNoteNode[] => {
    if (++count > 4000 || depth > 32) throw new Error("layout too large");
    if (node.type === "text") return [node.value];
    if (node.type !== "element" || dropped.has(node.tagName)) return [];
    const children = node.children.flatMap((child) => walk(child, depth + 1));
    if (!tags.has(node.tagName)) return children;
    const style = safeNoteStyle(String(node.properties.style ?? ""));
    const classes = Array.isArray(node.properties.className) ? node.properties.className.map(String) : [];
    if (classes.includes("grid")) style.display ??= "grid";
    if (classes.includes("flex")) style.display ??= "flex";
    const columns = classes.map((name) => /^grid-cols-(\d{1,2})$/.exec(name)).find(Boolean);
    if (columns && Number(columns[1]) <= 24) style.gridTemplateColumns ??= `repeat(${columns[1]}, minmax(0, 1fr))`;
    if (classes.includes("flex-col")) style.flexDirection ??= "column";
    for (const name of classes) {
      const gap = /^gap-(\d{1,2})$/.exec(name);
      if (gap && Number(gap[1]) <= 16) style.gap ??= `${Number(gap[1]) * 0.25}rem`;
    }
    if (["grid", "inline-grid", "flex", "inline-flex"].includes(style.display) || node.tagName === "table") hasLayout = true;
    const attrs: Record<string, string | number> = {};
    if (node.tagName === "img") {
      const src = String(node.properties.src ?? "");
      if (!safeNoteImage(src)) return [];
      attrs.src = src; attrs.alt = String(node.properties.alt ?? "图片");
    }
    if (node.tagName === "a" && /^https?:\/\//i.test(String(node.properties.href ?? ""))) attrs.href = String(node.properties.href);
    for (const attribute of ["colSpan", "rowSpan"]) {
      const value = Number(node.properties[attribute]);
      if (Number.isInteger(value) && value > 0 && value <= 24) attrs[attribute] = value;
    }
    return [{ tag: node.tagName, style, attrs, children }];
  };
  try {
    const nodes = root.children.flatMap((child) => walk(child, 0));
    return hasLayout ? nodes : null;
  } catch { return null; }
}

export function encodeNoteLayout(nodes: RichNoteNode[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(nodes));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return RICH_NOTE_PREFIX + btoa(binary);
}
export function decodeNoteLayout(src: string): RichNoteNode[] | null {
  if (!src.startsWith(RICH_NOTE_PREFIX) || src.length > NOTE_LAYOUT_MAX_BYTES) return null;
  let count = 0;
  const validate = (node: unknown, depth: number): node is RichNoteNode => {
    if (++count > 4000 || depth > 32) return false;
    if (typeof node === "string") return true;
    if (!node || typeof node !== "object") return false;
    const item = node as Record<string, unknown>;
    if (typeof item.tag !== "string" || !tags.has(item.tag) || !item.style || typeof item.style !== "object" || !item.attrs || typeof item.attrs !== "object" || !Array.isArray(item.children)) return false;
    if (!Object.entries(item.style).every(([key, value]) => styles.has(key) && styleValue(value))) return false;
    if (!Object.entries(item.attrs).every(([key, value]) => key === "src" ? typeof value === "string" && safeNoteImage(value)
      : key === "href" ? typeof value === "string" && /^https?:\/\/[^\s<>]+$/i.test(value)
      : key === "alt" ? typeof value === "string"
      : ["colSpan", "rowSpan"].includes(key) && typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 24)) return false;
    return item.children.every((child) => validate(child, depth + 1));
  };
  try {
    const binary = atob(src.slice(RICH_NOTE_PREFIX.length));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    return Array.isArray(parsed) && parsed.every((node) => validate(node, 0)) ? parsed : null;
  } catch { return null; }
}

/** This diagnoses lost structure, and deliberately does not guess a grid width or card layout. */
export function notePasteWarning(plain: string) {
  if ((plain.match(/^\s*\|\s*\|\s*\n\s*\|\s*-+\s*\|/gm)?.length ?? 0) >= 3 || (plain.match(/^\s*(?:🌱|🌵|🌻|🎃|·)\s*$/gm)?.length ?? 0) >= 12 || (plain.match(/第\s*\d+\s*株\s*\n/g)?.length ?? 0) >= 3) {
    return "这次复制的内容已丢失表格或图示布局。可从原页面拖选后复制，或直接粘贴截图保留原样。";
  }
  return "";
}
