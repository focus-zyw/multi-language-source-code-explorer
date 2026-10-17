import { eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { parseSource } from "@/lib/analysis/treesitter";
import { pluginForPath } from "@/lib/analysis/registry";
import { resolveProject, type FileUnit } from "@/lib/analysis/resolve";
import { linkTests } from "@/lib/analysis/tests-link";
import type { ProjectStats, SkipRecord, SkippedInfo } from "@/lib/shared";
import { ImportError, LIMITS } from "./rules";
import type { RawFile } from "./zip";

export interface IngestArgs {
  name: string;
  sourceType: "zip" | "folder" | "local";
  sourcePath?: string;
  replaceProjectId?: number;
  files: RawFile[];
  skipped: SkipRecord[];
  warnings: string[];
  /** 前端预过滤时已跳过的数量（仅作展示，服务端不信任） */
  clientSkipped?: Record<string, number>;
}

export interface IngestResult {
  projectId: number;
  fileCount: number;
  symbolCount: number;
  stats: ProjectStats;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function summarizeSkipped(list: SkipRecord[], clientSkipped?: Record<string, number>): SkippedInfo {
  const counts: Record<string, number> = {};
  for (const s of list) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  if (clientSkipped) {
    for (const [k, v] of Object.entries(clientSkipped)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) counts[`client:${k}`] = Math.floor(v);
    }
  }
  // 样本优先展示“有意义”的原因（安全拒绝、超限、二进制等），而不是海量的 node_modules
  const noisy = new Set(["ignored-dir", "unsupported-language"]);
  const important = list.filter((s) => !noisy.has(s.reason));
  const rest = list.filter((s) => noisy.has(s.reason));
  return { counts, samples: [...important.slice(0, 250), ...rest.slice(0, 50)] };
}

async function allocIds(tx: Pick<typeof db, "all">, table: string, n: number): Promise<number[]> {
  if (n <= 0) return [];
  // The write transaction reserves these IDs until all related rows are inserted.
  // sqlite_sequence preserves the high-water mark even after a project is deleted.
  const [row] = await tx.all<{ id: number }>(sql`select coalesce((select seq from sqlite_sequence where name = ${table}), 0) as id`);
  return Array.from({ length: n }, (_, i) => Number(row.id) + i + 1);
}

async function insertChunked<T>(rows: T[], cols: number, fn: (chunk: T[]) => Promise<unknown>) {
  // Stay below SQLite's variable limit, including older SQLite builds.
  const size = Math.max(1, Math.floor(900 / cols));
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

export async function ingestProject(args: IngestArgs): Promise<IngestResult> {
  const skipped: SkipRecord[] = [...args.skipped];
  const warnings = [...args.warnings];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  /* 1. 解码与内容级过滤（二进制 / 非 UTF-8 / 压缩产物） */
  interface Decoded {
    path: string;
    content: string;
    size: number;
  }
  const decoded: Decoded[] = [];
  for (const f of args.files) {
    if (f.data.length > LIMITS.maxFileBytes) {
      skipped.push({ path: f.path, reason: "too-large" });
      continue;
    }
    if (f.data.subarray(0, 8192).includes(0)) {
      skipped.push({ path: f.path, reason: "binary" });
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(f.data);
    } catch {
      skipped.push({ path: f.path, reason: "non-utf8" });
      continue;
    }
    if (text.includes("\u0000")) {
      skipped.push({ path: f.path, reason: "binary" });
      continue;
    }
    text = text.replace(/\r\n?/g, "\n");
    const lines = text.split("\n").length;
    if (text.length > 20_000 && text.length / lines > 300) {
      skipped.push({ path: f.path, reason: "minified" });
      continue;
    }
    decoded.push({ path: f.path, content: text, size: f.data.length });
  }
  decoded.sort((a, b) => a.path.localeCompare(b.path));

  /* 2. Tree-sitter 解析（纯语法分析，不执行任何项目代码） */
  const units: FileUnit[] = [];
  const contents: Decoded[] = [];
  let symbolTotal = 0;
  let n = 0;
  for (const d of decoded) {
    if (++n % 40 === 0) await tick();
    if (symbolTotal > LIMITS.maxSymbols) {
      skipped.push({ path: d.path, reason: "file-limit" });
      continue;
    }
    const m = pluginForPath(d.path);
    if (!m) {
      skipped.push({ path: d.path, reason: "unsupported-language" });
      continue;
    }
    let tree;
    try {
      tree = await parseSource(m.grammar, d.content);
    } catch {
      skipped.push({ path: d.path, reason: "parse-failed" });
      continue;
    }
    if (!tree) {
      skipped.push({ path: d.path, reason: "parse-timeout" });
      continue;
    }
    try {
      const extract = m.plugin.extract(tree.rootNode, d.content, d.path);
      symbolTotal += extract.symbols.length;
      units.push({ idx: units.length, path: d.path, language: m.plugin.id, plugin: m.plugin, extract, isTest: m.plugin.isTestFile(d.path) });
      contents.push(d);
    } catch {
      skipped.push({ path: d.path, reason: "parse-failed" });
    } finally {
      tree.delete();
    }
  }

  const languages: Record<string, number> = {};
  for (const u of units) languages[u.language] = (languages[u.language] ?? 0) + 1;
  if (args.files.length && !units.length) {
    throw new ImportError("未能解析任何源码文件，请检查文件内容并重试；原有分析不会被覆盖", 422);
  }

  /* 3. 入库（单事务）：分配 ID → 跨文件解析 → 测试关联 → 批量写入 */
  const result = await db.transaction(async (tx) => {
    if (args.replaceProjectId !== undefined) {
      const [existing] = await tx.select().from(schema.projects).where(eq(schema.projects.id, args.replaceProjectId)).limit(1);
      if (!existing) throw new ImportError("项目不存在", 404);
      if (existing.sourceType !== "local" || existing.sourcePath !== args.sourcePath) throw new ImportError("项目的本地来源已改变，请刷新后重试", 409);
    }
    const fileIds = await allocIds(tx, "files", units.length);
    const totalSymbols = units.reduce((a, u) => a + u.extract.symbols.length, 0);
    const flatSymIds = await allocIds(tx, "symbols", totalSymbols);
    const symbolIds: number[][] = [];
    let cursor = 0;
    for (const u of units) {
      symbolIds.push(u.extract.symbols.map(() => flatSymIds[cursor++]));
    }

    const resolved = resolveProject(units, symbolIds);
    const links = linkTests(units, symbolIds, resolved.refs);

    const stats: ProjectStats = {
      symbols: { function: 0, method: 0, class: 0, test: 0 },
      refs: { exact: 0, inferred: 0, heuristic: 0, external: 0, unresolved: 0 },
      testLinks: { exact: 0, inferred: 0, indirect: 0, heuristic: 0 },
      syntaxErrorFiles: units.filter((u) => u.extract.hasSyntaxErrors).length,
      unresolvedImports: resolved.imports.reduce((a, l) => a + l.filter((i) => i.kind === "unresolved").length, 0),
    };
    for (const u of units) for (const s of u.extract.symbols) stats.symbols[s.kind]++;
    for (const r of resolved.refs) stats.refs[r.resolution]++;
    for (const l of links) stats.testLinks[l.confidence]++;

    const projectValues = {
        name: args.name.slice(0, 120) || "未命名项目",
        sourceType: args.sourceType,
        sourcePath: args.sourcePath ?? null,
        scannedAt: new Date(),
        fileCount: units.length,
        symbolCount: totalSymbols,
        totalBytes: contents.reduce((a, d) => a + d.size, 0),
        languages,
        skipped: summarizeSkipped(skipped, args.clientSkipped),
        stats,
        warnings: warnings.slice(0, 20),
      };
    let projectId: number;
    if (args.replaceProjectId !== undefined) {
      projectId = args.replaceProjectId;
      // Cascades remove symbols, references, test links and stale AI explanations.
      // All replacement writes share this transaction; any failure restores the old snapshot.
      await tx.delete(schema.files).where(eq(schema.files.projectId, projectId));
      await tx.update(schema.projects).set(projectValues).where(eq(schema.projects.id, projectId));
    } else {
      const [project] = await tx.insert(schema.projects).values(projectValues).returning({ id: schema.projects.id });
      projectId = project.id;
    }

    await insertChunked(units, Object.keys(getTableColumns(schema.files)).length, (chunk) =>
      tx.insert(schema.files).values(
        chunk.map((u) => ({
          id: fileIds[u.idx],
          projectId,
          path: u.path,
          language: u.language,
          size: contents[u.idx].size,
          lineCount: contents[u.idx].content.split("\n").length,
          content: contents[u.idx].content,
          isTest: u.isTest,
          hasSyntaxErrors: u.extract.hasSyntaxErrors,
          imports: resolved.imports[u.idx],
        })),
      ),
    );

    const symRows = units.flatMap((u) =>
      u.extract.symbols.map((s) => ({
        id: symbolIds[u.idx][s.localId],
        projectId,
        fileId: fileIds[u.idx],
        parentId: s.parentLocalId === null ? null : symbolIds[u.idx][s.parentLocalId],
        kind: s.kind,
        name: s.name,
        qualifiedName: s.qualifiedName,
        container: s.container,
        isAsync: s.isAsync,
        isGenerator: s.isGenerator,
        isTest: s.isTest,
        signature: s.signature,
        params: s.params,
        decorators: s.decorators,
        docstring: s.docstring,
        returnType: s.returnType,
        bases: s.bases,
        startLine: s.startLine,
        startCol: s.startCol,
        endLine: s.endLine,
        endCol: s.endCol,
        startIndex: s.startIndex,
        endIndex: s.endIndex,
        defStartIndex: s.defStartIndex,
        defEndIndex: s.defEndIndex,
        metrics: s.metrics,
      })),
    );
    await insertChunked(symRows, Object.keys(getTableColumns(schema.symbols)).length, (chunk) => tx.insert(schema.symbols).values(chunk));

    const refIds = await allocIds(tx, "refs", resolved.refs.length);
    const refRows = resolved.refs.map((r, i) => ({
      id: refIds[i],
      projectId,
      ownerSymbolId: r.ownerSymbolId,
      fileId: fileIds[r.fileIdx],
      kind: r.call.kind,
      name: r.call.name,
      receiver: r.call.receiver,
      calleeText: r.call.calleeText,
      line: r.call.line,
      col: r.call.col,
      endLine: r.call.endLine,
      endCol: r.call.endCol,
      resolution: r.resolution,
      reason: r.reason,
    }));
    await insertChunked(refRows, Object.keys(getTableColumns(schema.refs)).length, (chunk) => tx.insert(schema.refs).values(chunk));

    const targetRows = resolved.refs.flatMap((r, i) =>
      r.targets.map((t) => ({ projectId, refId: refIds[i], targetSymbolId: t.symbolId, confidence: t.confidence, score: t.score, reason: t.reason })),
    );
    await insertChunked(targetRows, Object.keys(getTableColumns(schema.refTargets)).length, (chunk) => tx.insert(schema.refTargets).values(chunk));

    await insertChunked(links, Object.keys(getTableColumns(schema.testLinks)).length, (chunk) =>
      tx.insert(schema.testLinks).values(
        chunk.map((l) => ({
          projectId,
          testSymbolId: l.testSymbolId,
          targetSymbolId: l.targetSymbolId,
          method: l.method,
          confidence: l.confidence,
          score: l.score,
          reason: l.reason,
          viaSymbolId: l.viaSymbolId,
        })),
      ),
    );

    return { projectId, fileCount: units.length, symbolCount: totalSymbols, stats };
  });

  return result;
}
