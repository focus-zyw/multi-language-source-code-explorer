import { isLearningAnchor, type LearningAnchor } from "./learning-types.ts";
import { NOTE_STATES, parseNoteContent, type NoteContent, type NoteQuote } from "./note-types.ts";
export const NOTE_PACKAGE_BYTES = 10 * 1024 * 1024;
export interface PortableNote extends NoteContent { id: string; anchor: LearningAnchor | null; quote: NoteQuote | null; createdAt: number; updatedAt: number }
export interface PortableLink { source: string; target: string; label: string }
export interface NotePackage { format: "code-atlas-notes"; schemaVersion: 1; notes: PortableNote[]; links: PortableLink[] }
export interface ImportPreview { token: string; added: number; skipped: number; copies: number; linksAdded: number; linksSkipped: number; evidence: number }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
export function parseNotePackage(value: unknown): NotePackage {
  if (!object(value) || value.format !== "code-atlas-notes" || value.schemaVersion !== 1) throw new Error("不支持的笔记格式或 schemaVersion");
  if (!Array.isArray(value.notes) || value.notes.length > 1000 || !Array.isArray(value.links) || value.links.length > 5000) throw new Error("导入包最多 1000 篇笔记、5000 条关联");
  const ids = new Set<string>();
  const notes = value.notes.map((n): PortableNote => {
    if (!object(n)) throw new Error("笔记记录无效");
    const content = parseNoteContent(n);
    if (!content || typeof n.id !== "string" || !uuid.test(n.id) || ids.has(n.id)) throw new Error("笔记内容、ID 无效或 ID 重复");
    ids.add(n.id);
    if (n.anchor !== null && !isLearningAnchor(n.anchor)) throw new Error("源码引用格式无效");
    let quote: NoteQuote | null = null;
    if (n.quote !== null) {
      const q = n.quote;
      if (!object(q) || typeof q.text !== "string" || !q.text.trim() || q.text.length > 6000 || typeof q.prefix !== "string" || q.prefix.length > 60 || typeof q.suffix !== "string" || q.suffix.length > 60) throw new Error("原始选区格式无效");
      quote = { text: q.text, prefix: q.prefix, suffix: q.suffix };
    }
    if (![n.createdAt, n.updatedAt].every((t) => typeof t === "number" && Number.isSafeInteger(t) && t >= 0 && t <= 8640000000000000)) throw new Error("笔记时间无效");
    const a = n.anchor as LearningAnchor | null;
    // Normalize field order and drop all unknown fields; imported paths remain inert evidence.
    const anchor = a ? { version: 1 as const, path: a.path, language: a.language, kind: a.kind, name: a.name, hash: a.hash, unique: a.unique } : null;
    return { id: n.id, ...content, anchor, quote, createdAt: n.createdAt as number, updatedAt: n.updatedAt as number };
  });
  const pairs = new Set<string>();
  const links = value.links.map((l): PortableLink => {
    if (!object(l) || typeof l.source !== "string" || typeof l.target !== "string" || !ids.has(l.source) || !ids.has(l.target) || l.source === l.target || typeof l.label !== "string" || l.label.length > 200) throw new Error("关联目标必须是包内另一篇笔记，说明最多 200 字符");
    const pair = `${l.source}:${l.target}`; if (pairs.has(pair)) throw new Error("关联记录重复"); pairs.add(pair);
    return { source: l.source, target: l.target, label: l.label.trim() };
  });
  const result: NotePackage = { format: "code-atlas-notes", schemaVersion: 1, notes, links };
  if (new TextEncoder().encode(JSON.stringify(result)).length > NOTE_PACKAGE_BYTES) throw new Error("笔记包最多 10MB，请分批导出");
  return result;
}
function inline(text: string) { return text.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>#|!]/g, "\\$&"); }
export function notesMarkdown(pack: NotePackage): string {
  const titles = new Map(pack.notes.map((n) => [n.id, n.title]));
  return ["# Code Atlas 个人学习笔记", ...pack.notes.map((n) => {
    const relations = pack.links.filter((l) => l.source === n.id).map((l) => `- ${inline(titles.get(l.target)!)}${l.label ? `：${inline(l.label)}` : ""}（${l.target}）`).join("\n");
    // Fence length exceeds every run of backticks in quoted code.
    const fence = "`".repeat(Math.max(3, ...[...(n.quote?.text ?? "").matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `## ${inline(n.title)}\n\nID：${n.id}\n\n状态：${NOTE_STATES[n.status]} · 标签：${n.tags.map(inline).join("、")}\n\n${n.body}\n${n.anchor ? `\n原源码依据（导入后不自动绑定）：${inline(n.anchor.path)} · ${inline(n.anchor.name)}\n` : ""}${n.quote ? `\n原始选区：\n\n${fence}\n${n.quote.text}\n${fence}\n` : ""}${relations ? `\n关联笔记：\n\n${relations}\n` : ""}`;
  })].join("\n\n");
}
