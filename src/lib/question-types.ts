import type { ExplanationBackend } from "./ai-types.ts";

export interface QuestionQuote { kind: "code" | "explanation"; text: string; startLine?: number; endLine?: number }
export interface QuestionSource { key: string; symbolId: number; path: string; name: string; startLine: number; endLine: number; hash: string }
export interface QuestionTurn {
  id: number; question: string; quote: QuestionQuote | null; answer: string | null;
  fingerprint: string; sources: QuestionSource[]; status: "pending" | "completed" | "cancelled" | "failed";
  model: string | null; createdAt: string; outdated?: boolean;
}
export interface QuestionHistory { identity: string; fingerprint: string; backend: ExplanationBackend; turns: QuestionTurn[] }
export interface QuestionInput { backend: ExplanationBackend; question: string; quote?: QuestionQuote | null; relatedIds?: number[]; fingerprint: string; requestId: string }

export function parseQuestionInput(value: unknown): QuestionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.backend !== "api" && v.backend !== "agent" || typeof v.question !== "string" || !v.question.trim() || v.question.length > 4000 || typeof v.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(v.fingerprint) || typeof v.requestId !== "string" || !/^[\w-]{8,80}$/.test(v.requestId)) return null;
  let quote: QuestionQuote | null = null;
  if (v.quote != null) {
    if (typeof v.quote !== "object" || Array.isArray(v.quote)) return null;
    const q = v.quote as Record<string, unknown>;
    if (q.kind !== "code" && q.kind !== "explanation" || typeof q.text !== "string" || !q.text.trim() || q.text.length > 6000) return null;
    if ([q.startLine, q.endLine].some((n) => n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 1))) return null;
    if (q.startLine !== undefined && q.endLine !== undefined && Number(q.endLine) < Number(q.startLine)) return null;
    quote = { kind: q.kind, text: q.text, ...(q.startLine === undefined ? {} : { startLine: Number(q.startLine) }), ...(q.endLine === undefined ? {} : { endLine: Number(q.endLine) }) };
  }
  if (v.relatedIds !== undefined && (!Array.isArray(v.relatedIds) || v.relatedIds.length > 3 || !v.relatedIds.every((n) => Number.isSafeInteger(n) && n > 0))) return null;
  return { backend: v.backend, question: v.question.trim(), quote, relatedIds: [...new Set(v.relatedIds as number[] ?? [])], fingerprint: v.fingerprint, requestId: v.requestId };
}

/** Only a known source and an in-range relative line span becomes clickable. */
export function questionCitation(href: string, sources: QuestionSource[]) {
  const match = /^source:(\d+):(\d+)(?:-(\d+))?$/.exec(href);
  if (!match) return null;
  const source = sources.find((s) => s.key === match[1]);
  const start = Number(match[2]), end = Number(match[3] ?? match[2]);
  if (!source || !Number.isSafeInteger(end) || start < 1 || end < start || end > source.endLine - source.startLine + 1) return null;
  return { source, startLine: source.startLine + start - 1, endLine: source.startLine + end - 1 };
}
