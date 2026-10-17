import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import { files, refs, refTargets, symbols } from "@/db/schema";
import type { CallTreeDirection, CallTreePage } from "./api-types";
import type { ResolutionT } from "./shared";

const PAGE_SIZE = 10;

/** One level of call sites only. Expanding a method requests its own next level. */
export async function getCallTreePage(projectId: number, symbolId: number, direction: CallTreeDirection, offset: number, includeBoundaries = true): Promise<CallTreePage | null> {
  const [symbol] = await db.select({ id: symbols.id, name: symbols.qualifiedName, kind: symbols.kind, filePath: files.path, line: symbols.startLine })
    .from(symbols).innerJoin(files, eq(symbols.fileId, files.id))
    .where(and(eq(symbols.projectId, projectId), eq(files.projectId, projectId), eq(symbols.id, symbolId))).limit(1);
  if (!symbol) return null;
  if (direction === "incoming") {
    const caller = alias(symbols, "caller");
    const rows = await db.select({ refId: refs.id, label: refs.calleeText, line: refs.line, filePath: files.path,
      confidence: refTargets.confidence, reason: refTargets.reason, id: caller.id, name: caller.qualifiedName, kind: caller.kind, startLine: caller.startLine })
      .from(refTargets).innerJoin(refs, eq(refTargets.refId, refs.id)).innerJoin(caller, eq(refs.ownerSymbolId, caller.id)).innerJoin(files, eq(refs.fileId, files.id))
      .where(and(eq(refTargets.projectId, projectId), eq(refTargets.targetSymbolId, symbolId), eq(refs.projectId, projectId), eq(caller.projectId, projectId), eq(files.projectId, projectId)))
      .orderBy(asc(refs.id), asc(refTargets.id)).limit(PAGE_SIZE + 1).offset(offset);
    return { symbol, direction, scope: includeBoundaries ? "all" : "project", nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
      branches: rows.slice(0, PAGE_SIZE).map((row) => ({ refId: row.refId, label: row.label, line: row.line, filePath: row.filePath,
        resolution: row.confidence as ResolutionT, reason: row.reason,
        targets: [{ symbol: { id: row.id, name: row.name, kind: row.kind, filePath: row.filePath, line: row.startLine }, confidence: row.confidence as ResolutionT, reason: row.reason }] })) };
  }
  const rows = await db.select().from(refs).where(and(eq(refs.projectId, projectId), eq(refs.ownerSymbolId, symbolId),
    includeBoundaries ? undefined : inArray(refs.id, db.select({ id: refTargets.refId }).from(refTargets).where(eq(refTargets.projectId, projectId)))))
    .orderBy(asc(refs.line), asc(refs.col), asc(refs.id)).limit(PAGE_SIZE + 1).offset(offset);
  const page = rows.slice(0, PAGE_SIZE);
  const targets = page.length ? await db.select({ refId: refTargets.refId, confidence: refTargets.confidence, reason: refTargets.reason,
    id: symbols.id, name: symbols.qualifiedName, kind: symbols.kind, filePath: files.path, line: symbols.startLine })
    .from(refTargets).innerJoin(symbols, eq(refTargets.targetSymbolId, symbols.id)).innerJoin(files, eq(symbols.fileId, files.id))
    .where(and(eq(refTargets.projectId, projectId), eq(symbols.projectId, projectId), eq(files.projectId, projectId), inArray(refTargets.refId, page.map((row) => row.id))))
    .orderBy(asc(refTargets.id)) : [];
  return { symbol, direction, scope: includeBoundaries ? "all" : "project", nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
    branches: page.map((row) => ({ refId: row.id, label: row.calleeText, line: row.line, filePath: symbol.filePath, resolution: row.resolution as ResolutionT, reason: row.reason,
      targets: targets.filter((target) => target.refId === row.id).map((target) => ({ symbol: { id: target.id, name: target.name, kind: target.kind, filePath: target.filePath, line: target.line }, confidence: target.confidence as ResolutionT, reason: target.reason })) })) };
}
