import { and, asc, eq, getTableColumns, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { files, refs, refTargets, symbols, symbolExplanations } from "@/db/schema";
import { fingerprintExplanation, storedExplanationFingerprint, type ExplanationFingerprintInput, type FingerprintTarget } from "./explanation-fingerprint";

type ExplanationRow = typeof symbolExplanations.$inferInsert;
type LegacyFields = Pick<typeof symbols.$inferSelect, "aiExplanation" | "aiModel" | "aiGeneratedAt">;
interface Snapshot {
  entries: { ownerId: number; fingerprint: string; absoluteLines: boolean; value: Omit<ExplanationRow, "id" | "symbolId"> }[];
  legacy: { ownerId: number; fingerprint: string; value: LegacyFields }[];
}

/** Read only files/calls belonging to symbols that actually have cached explanations. */
export async function snapshotExplanations(tx: Pick<typeof db, "select">, projectId: number): Promise<Snapshot> {
  const condition = and(eq(symbols.projectId, projectId), or(isNotNull(symbols.aiExplanation), inArray(symbols.id, tx.select({ id: symbolExplanations.symbolId }).from(symbolExplanations))));
  const cachedIds = tx.select({ id: symbols.id }).from(symbols).where(condition);
  const oldSymbols = await tx.select().from(symbols).where(condition);
  if (!oldSymbols.length) return { entries: [], legacy: [] };
  const [cacheRows, fileRows, callRows, targetRows] = await Promise.all([
    tx.select(getTableColumns(symbolExplanations)).from(symbolExplanations).innerJoin(symbols, eq(symbolExplanations.symbolId, symbols.id)).where(eq(symbols.projectId, projectId)),
    tx.select().from(files).where(and(eq(files.projectId, projectId), inArray(files.id, tx.select({ id: symbols.fileId }).from(symbols).where(condition)))),
    tx.select().from(refs).where(and(eq(refs.projectId, projectId), inArray(refs.ownerSymbolId, cachedIds))).orderBy(asc(refs.line), asc(refs.col), asc(refs.id)),
    tx.select({ refId: refTargets.refId, filePath: files.path, name: symbols.qualifiedName, kind: symbols.kind, confidence: refTargets.confidence })
      .from(refTargets).innerJoin(refs, eq(refTargets.refId, refs.id)).innerJoin(symbols, eq(refTargets.targetSymbolId, symbols.id)).innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(refTargets.projectId, projectId), eq(refs.projectId, projectId), eq(symbols.projectId, projectId), eq(files.projectId, projectId), inArray(refs.ownerSymbolId, cachedIds))),
  ]);
  const fileById = new Map(fileRows.map((file) => [file.id, file]));
  const targets = new Map<number, FingerprintTarget[]>();
  for (const target of targetRows) { const list = targets.get(target.refId) ?? []; list.push(target); targets.set(target.refId, list); }
  const calls = new Map<number, ExplanationFingerprintInput["calls"]>();
  for (const call of callRows) { const list = calls.get(call.ownerSymbolId) ?? []; list.push({ ...call, targets: targets.get(call.id) ?? [] }); calls.set(call.ownerSymbolId, list); }
  const hashes = new Map<number, { relative: string; absolute: string }>();
  const snapshot: Snapshot = { entries: [], legacy: [] };
  for (const symbol of oldSymbols) {
    const file = fileById.get(symbol.fileId);
    if (!file) continue;
    const input = { symbol, filePath: file.path, language: file.language, source: file.content.slice(symbol.startIndex, symbol.endIndex), calls: calls.get(symbol.id) ?? [] };
    const pair = { relative: fingerprintExplanation(input), absolute: fingerprintExplanation(input, true) };
    hashes.set(symbol.id, pair);
    if (symbol.aiExplanation) snapshot.legacy.push({ ownerId: symbol.id, fingerprint: pair.absolute, value: { aiExplanation: symbol.aiExplanation, aiModel: symbol.aiModel, aiGeneratedAt: symbol.aiGeneratedAt } });
  }
  for (const row of cacheRows) {
    const pair = hashes.get(row.symbolId);
    if (!pair) continue;
    const savedFingerprint = storedExplanationFingerprint(row.configKey);
    if (savedFingerprint && savedFingerprint !== pair.relative) continue;
    snapshot.entries.push({ ownerId: row.symbolId, fingerprint: savedFingerprint ?? pair.absolute, absoluteLines: savedFingerprint === null,
      value: { backend: row.backend, configKey: row.configKey, content: row.content, model: row.model, generatedAt: row.generatedAt } });
  }
  return snapshot;
}

/** Ambiguous duplicate definitions are intentionally not matched by their content alone. */
export function matchExplanations(snapshot: Snapshot, inputs: Map<number, ExplanationFingerprintInput>) {
  const relative = new Map<string, number[]>(), absolute = new Map<string, number[]>();
  for (const [id, input] of inputs) {
    for (const [index, hash] of [[relative, fingerprintExplanation(input)], [absolute, fingerprintExplanation(input, true)]] as const) {
      const ids = index.get(hash) ?? []; ids.push(id); index.set(hash, ids);
    }
  }
  const rows: ExplanationRow[] = [];
  const legacy = new Map<number, LegacyFields>();
  const owners = new Map<string, Set<number>>();
  for (const saved of [...snapshot.entries.map((entry) => ({ ...entry, key: `${entry.absoluteLines}:${entry.fingerprint}` })),
    ...snapshot.legacy.map((entry) => ({ ...entry, key: `true:${entry.fingerprint}` }))]) {
    const ids = owners.get(saved.key) ?? new Set<number>(); ids.add(saved.ownerId); owners.set(saved.key, ids);
  }
  for (const saved of snapshot.entries) {
    if (owners.get(`${saved.absoluteLines}:${saved.fingerprint}`)!.size > 1) continue;
    const ids = (saved.absoluteLines ? absolute : relative).get(saved.fingerprint);
    if (ids?.length === 1) rows.push({ ...saved.value, symbolId: ids[0] });
  }
  for (const saved of snapshot.legacy) {
    if (owners.get(`true:${saved.fingerprint}`)!.size > 1) continue;
    const ids = absolute.get(saved.fingerprint);
    if (ids?.length === 1) legacy.set(ids[0], saved.value);
  }
  return { rows, legacy };
}
