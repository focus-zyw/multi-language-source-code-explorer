import type { AnchorResolution, LearningAnchor } from "./learning-types.ts";
export const NOTE_STATES = { unread: "待阅读", reading: "阅读中", understood: "已理解" } as const;
export interface NoteContent { title: string; body: string; tags: string[]; status: keyof typeof NOTE_STATES }
export interface NoteQuote { text: string; prefix: string; suffix: string }
export interface LearningNote extends NoteContent {
  id: string; version: number; anchor: LearningAnchor | null; quote: NoteQuote | null;
  deletedAt: number | null; createdAt: number; updatedAt: number;
}
export interface NoteView extends LearningNote {
  resolution: AnchorResolution | null; quoteStartLine: number | null; quoteEndLine: number | null;
  importedAnchor?: LearningAnchor | null;
}
export interface NoteReference { id: string; title: string; deleted: boolean; label: string }
export interface NoteConnections { outgoing: NoteReference[]; incoming: NoteReference[]; choices: { id: string; title: string }[] }
export interface NoteList { revision: number; total: number; page: number; items: NoteView[] }
export function parseNoteContent(value: unknown): NoteContent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== "string" || !v.title.trim() || v.title.length > 120 || typeof v.body !== "string" || new TextEncoder().encode(v.body).length > 32768 ||
    !Array.isArray(v.tags) || v.tags.length > 10 || !v.tags.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= 40) ||
    typeof v.status !== "string" || !Object.hasOwn(NOTE_STATES, v.status)) return null;
  return { title: v.title.trim(), body: v.body, tags: [...new Set(v.tags.map((t) => t.trim()))], status: v.status as NoteContent["status"] };
}
export function locateQuote(source: string, quote: NoteQuote): number | null {
  const positions: number[] = [];
  for (let from = 0; from <= source.length;) {
    const index = source.indexOf(quote.text, from); if (index < 0) break;
    positions.push(index); from = index + 1;
    if (positions.length > 200) return null;
  }
  if (positions.length === 1) return positions[0];
  const matching = positions.filter((i) => source.slice(Math.max(0, i - quote.prefix.length), i) === quote.prefix && source.slice(i + quote.text.length, i + quote.text.length + quote.suffix.length) === quote.suffix);
  return matching.length === 1 ? matching[0] : null;
}
