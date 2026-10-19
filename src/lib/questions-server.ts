import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { files, symbols, symbolQuestions } from "@/db/schema";
import { getSymbolForExplain } from "./queries";
import { fingerprintExplanation } from "./explanation-fingerprint";
import type { QuestionHistory, QuestionSource, QuestionTurn } from "./question-types";
import type { ExplanationBackend } from "./ai-types";

let ready: Promise<void> | undefined;
/** Additive migration only; existing source and explanation tables are untouched. */
export function ensureQuestions() {
  return ready ??= (async () => {
    await db.run(sql`CREATE TABLE IF NOT EXISTS symbol_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, identity TEXT NOT NULL, backend TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, question TEXT NOT NULL, quote TEXT, sources TEXT NOT NULL, answer TEXT, status TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS symbol_questions_owner_idx ON symbol_questions(project_id, identity, backend)`);
    await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS symbol_questions_request_idx ON symbol_questions(project_id, request_id)`);
  })().catch((error) => { ready = undefined; throw error; });
}

export const sourceHash = (code: string) => createHash("sha256").update(code.replace(/\r\n?/g, "\n")).digest("hex");

export async function questionOwner(projectId: number, symbolId: number) {
  const data = await getSymbolForExplain(projectId, symbolId);
  if (!data) return null;
  const { sym, file } = data;
  const duplicates = await db.select({ id: symbols.id }).from(symbols).where(and(eq(symbols.fileId, file.id), eq(symbols.qualifiedName, sym.qualifiedName), eq(symbols.kind, sym.kind)));
  // Ambiguous names start a new history after a rescan rather than mixing owners.
  const identity = sourceHash(JSON.stringify([file.path, sym.qualifiedName, sym.kind, duplicates.length > 1 ? sym.id : null]));
  const fingerprint = fingerprintExplanation({ symbol: sym, filePath: file.path, language: file.language, source: file.content.slice(sym.startIndex, sym.endIndex), calls: data.fingerprintCalls });
  return { ...data, identity, fingerprint };
}

export function questionSource(data: NonNullable<Awaited<ReturnType<typeof questionOwner>>>, key: string) {
  const full = data.file.content.slice(data.sym.startIndex, data.sym.endIndex);
  const code = full.slice(0, 14000);
  const meta: QuestionSource = { key, symbolId: data.sym.id, path: data.file.path, name: data.sym.qualifiedName, startLine: data.sym.startLine,
    endLine: data.sym.startLine + code.split("\n").length - 1, hash: sourceHash(full) };
  return { meta, code, truncated: code.length < full.length };
}

export async function questionHistory(projectId: number, owner: NonNullable<Awaited<ReturnType<typeof questionOwner>>>, backend: ExplanationBackend): Promise<QuestionHistory> {
  await ensureQuestions();
  const rows = await db.select().from(symbolQuestions).where(and(eq(symbolQuestions.projectId, projectId), eq(symbolQuestions.identity, owner.identity), eq(symbolQuestions.backend, backend))).orderBy(desc(symbolQuestions.id)).limit(40);
  const resolved = new Map<string, Promise<QuestionSource | null>>();
  const resolve = (source: QuestionSource) => {
    const key = `${source.path}\0${source.name}\0${source.hash}\0${source.key}\0${source.endLine - source.startLine}`;
    if (!resolved.has(key)) resolved.set(key, (async () => {
      const matches = await db.select({ symbol: symbols, file: files }).from(symbols).innerJoin(files, eq(files.id, symbols.fileId))
        .where(and(eq(symbols.projectId, projectId), eq(files.path, source.path), eq(symbols.qualifiedName, source.name))).limit(2);
      if (matches.length !== 1) return null;
      const { symbol, file } = matches[0];
      if (sourceHash(file.content.slice(symbol.startIndex, symbol.endIndex)) !== source.hash) return null;
      return { ...source, symbolId: symbol.id, startLine: symbol.startLine, endLine: symbol.startLine + source.endLine - source.startLine };
    })());
    return resolved.get(key)!;
  };
  const turns: QuestionTurn[] = [];
  for (const row of rows.reverse()) {
    const sources = await Promise.all(row.sources.map(resolve));
    const lineShift = sources[0] && row.sources[0] ? sources[0].startLine - row.sources[0].startLine : 0;
    const quote = row.quote?.kind === "code" && row.quote.startLine && row.quote.endLine ? { ...row.quote, startLine: row.quote.startLine + lineShift, endLine: row.quote.endLine + lineShift } : row.quote;
    turns.push({ id: row.id, question: row.question, quote, answer: row.answer, fingerprint: row.fingerprint,
      sources: sources.filter((source): source is QuestionSource => source !== null), status: row.status as QuestionTurn["status"], model: row.model, createdAt: row.createdAt.toISOString(), outdated: row.fingerprint !== owner.fingerprint || sources.some((source) => source === null) });
  }
  return { identity: owner.identity, fingerprint: owner.fingerprint, backend, turns };
}
