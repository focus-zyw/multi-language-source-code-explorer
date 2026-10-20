import "server-only";
import { and, asc, desc, eq, inArray, or, sql, getTableColumns } from "drizzle-orm";
import { ensureLearningTables } from "./learning-store";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import { files, projects, refTargets, refs, symbols, testLinks, symbolExplanations } from "@/db/schema";
import { getAiPublicStatus, explanationConfigKey } from "@/lib/ai";
import type { ExplanationBackend, ExplanationResult } from "@/lib/ai-types";
import { explanationMatchesConfig, fingerprintExplanation, storedExplanationFingerprint, type FingerprintTarget } from "@/lib/explanation-fingerprint";
import { buildStaticSummary } from "@/lib/analysis/summary";
import { buildFlowGraph } from "@/lib/analysis/flow";
import { pluginById, pluginForPath } from "@/lib/analysis/registry";
import { parseSource } from "@/lib/analysis/treesitter";
import { findNodeByRange } from "@/lib/analysis/util";
import type {
  AnalysisResult,
  IncomingRef,
  OutgoingRef,
  ProjectInfo,
  ProjectListItem,
  SymbolDetail,
  TestLinkView,
  TreeData,
} from "@/lib/api-types";

export function parseId(v: string): number | null {
  if (!/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

export async function listProjects(): Promise<ProjectListItem[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      sourceType: projects.sourceType,
      sourcePath: projects.sourcePath,
      scannedAt: projects.scannedAt,
      fileCount: projects.fileCount,
      symbolCount: projects.symbolCount,
      languages: projects.languages,
      stats: projects.stats,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), scannedAt: r.scannedAt?.toISOString() ?? null }));
}

export async function getProject(id: number): Promise<ProjectInfo | null> {
  await ensureLearningTables(db);
  const [r] = await db.select({ ...getTableColumns(projects), scanRevision: sql<number>`coalesce((select revision from project_scan_versions where project_id = ${id}), 1)` }).from(projects).where(eq(projects.id, id)).limit(1);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    sourceType: r.sourceType,
    sourcePath: r.sourcePath,
    scannedAt: r.scannedAt?.toISOString() ?? null,
    fileCount: r.fileCount,
    symbolCount: r.symbolCount,
    languages: r.languages,
    stats: r.stats,
    createdAt: r.createdAt.toISOString(),
    totalBytes: r.totalBytes,
    scanRevision: r.scanRevision,
    skipped: r.skipped,
    warnings: r.warnings,
  };
}

export async function getTree(projectId: number): Promise<TreeData> {
  const [fileRows, symRows] = await Promise.all([
    db
      .select({ id: files.id, path: files.path, language: files.language, isTest: files.isTest, hasSyntaxErrors: files.hasSyntaxErrors })
      .from(files)
      .where(eq(files.projectId, projectId))
      .orderBy(asc(files.path)),
    db
      .select({
        id: symbols.id,
        fileId: symbols.fileId,
        parentId: symbols.parentId,
        kind: symbols.kind,
        name: symbols.name,
        qualifiedName: symbols.qualifiedName,
        container: symbols.container,
        startLine: symbols.startLine,
        isTest: symbols.isTest,
      })
      .from(symbols)
      .where(eq(symbols.projectId, projectId))
      .orderBy(asc(symbols.fileId), asc(symbols.startLine)),
  ]);
  return { files: fileRows, symbols: symRows as TreeData["symbols"] };
}

export async function getSymbolDetail(projectId: number, symbolId: number): Promise<SymbolDetail | null> {
  const [sym] = await db
    .select()
    .from(symbols)
    .where(and(eq(symbols.id, symbolId), eq(symbols.projectId, projectId)))
    .limit(1);
  if (!sym) return null;
  const [file] = await db.select().from(files).where(eq(files.id, sym.fileId)).limit(1);
  if (!file) return null;

  const parent = sym.parentId
    ? (await db.select({ id: symbols.id, name: symbols.qualifiedName, kind: symbols.kind }).from(symbols).where(eq(symbols.id, sym.parentId)).limit(1))[0] ?? null
    : null;
  const children = await db
    .select({ id: symbols.id, name: symbols.name, kind: symbols.kind, startLine: symbols.startLine })
    .from(symbols)
    .where(and(eq(symbols.parentId, sym.id), eq(symbols.projectId, projectId)))
    .orderBy(asc(symbols.startLine));

  /* 出向引用 */
  const refRows = await db.select().from(refs).where(eq(refs.ownerSymbolId, sym.id)).orderBy(asc(refs.line), asc(refs.col));
  const targetsByRef = new Map<number, OutgoingRef["targets"]>();
  if (refRows.length) {
    const tRows = await db
      .select({
        refId: refTargets.refId,
        symbolId: refTargets.targetSymbolId,
        confidence: refTargets.confidence,
        score: refTargets.score,
        reason: refTargets.reason,
        name: symbols.qualifiedName,
        kind: symbols.kind,
        line: symbols.startLine,
        filePath: files.path,
      })
      .from(refTargets)
      .innerJoin(symbols, eq(refTargets.targetSymbolId, symbols.id))
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(inArray(refTargets.refId, refRows.map((r) => r.id)))
      .orderBy(desc(refTargets.score));
    for (const t of tRows) {
      const l = targetsByRef.get(t.refId) ?? [];
      l.push({ symbolId: t.symbolId, name: t.name, kind: t.kind, filePath: t.filePath, line: t.line, confidence: t.confidence as "exact", score: t.score, reason: t.reason });
      targetsByRef.set(t.refId, l);
    }
  }
  const outgoing: OutgoingRef[] = refRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    receiver: r.receiver,
    calleeText: r.calleeText,
    line: r.line,
    col: r.col,
    endLine: r.endLine,
    endCol: r.endCol,
    resolution: r.resolution as OutgoingRef["resolution"],
    reason: r.reason,
    targets: targetsByRef.get(r.id) ?? [],
  }));

  /* 入向引用（谁调用了我） */
  const os = alias(symbols, "os");
  const incRows = await db
    .select({
      refId: refs.id,
      fromSymbolId: os.id,
      fromName: os.qualifiedName,
      fromKind: os.kind,
      filePath: files.path,
      line: refs.line,
      calleeText: refs.calleeText,
      confidence: refTargets.confidence,
      score: refTargets.score,
      reason: refTargets.reason,
    })
    .from(refTargets)
    .innerJoin(refs, eq(refTargets.refId, refs.id))
    .innerJoin(os, eq(refs.ownerSymbolId, os.id))
    .innerJoin(files, eq(refs.fileId, files.id))
    .where(and(eq(refTargets.targetSymbolId, sym.id), eq(refTargets.projectId, projectId)))
    .orderBy(desc(refTargets.score))
    .limit(300);
  const incoming: IncomingRef[] = incRows.map((r) => ({ ...r, confidence: r.confidence as IncomingRef["confidence"] }));

  /* 关联测试 */
  const ts = alias(symbols, "ts");
  const tg = alias(symbols, "tg");
  const tfile = alias(files, "tfile");
  const gfile = alias(files, "gfile");
  const targetIds = sym.kind === "class" ? [sym.id, ...children.map((c) => c.id)] : [sym.id];
  const tests: TestLinkView[] = [];
  if (sym.kind === "test") {
    const rows = await db
      .select({
        otherSymbolId: tg.id,
        otherName: tg.qualifiedName,
        otherKind: tg.kind,
        filePath: gfile.path,
        line: tg.startLine,
        method: testLinks.method,
        confidence: testLinks.confidence,
        score: testLinks.score,
        reason: testLinks.reason,
        viaSymbolId: testLinks.viaSymbolId,
      })
      .from(testLinks)
      .innerJoin(tg, eq(testLinks.targetSymbolId, tg.id))
      .innerJoin(gfile, eq(tg.fileId, gfile.id))
      .where(and(eq(testLinks.testSymbolId, sym.id), eq(testLinks.projectId, projectId)))
      .orderBy(desc(testLinks.score));
    const viaIds = rows.map((r) => r.viaSymbolId).filter((x): x is number => x !== null);
    const viaMap = new Map<number, string>();
    if (viaIds.length) {
      for (const v of await db.select({ id: symbols.id, name: symbols.qualifiedName }).from(symbols).where(inArray(symbols.id, viaIds))) viaMap.set(v.id, v.name);
    }
    for (const r of rows) {
      tests.push({
        direction: "covers",
        otherSymbolId: r.otherSymbolId,
        otherName: r.otherName,
        otherKind: r.otherKind,
        filePath: r.filePath,
        line: r.line,
        targetSymbolId: r.otherSymbolId,
        targetName: r.otherName,
        method: r.method as TestLinkView["method"],
        confidence: r.confidence as TestLinkView["confidence"],
        score: r.score,
        reason: r.reason,
        via: r.viaSymbolId !== null ? { id: r.viaSymbolId, name: viaMap.get(r.viaSymbolId) ?? "?" } : null,
      });
    }
  } else {
    const rows = await db
      .select({
        otherSymbolId: ts.id,
        otherName: ts.qualifiedName,
        otherKind: ts.kind,
        filePath: tfile.path,
        line: ts.startLine,
        targetSymbolId: testLinks.targetSymbolId,
        targetName: tg.qualifiedName,
        method: testLinks.method,
        confidence: testLinks.confidence,
        score: testLinks.score,
        reason: testLinks.reason,
        viaSymbolId: testLinks.viaSymbolId,
      })
      .from(testLinks)
      .innerJoin(ts, eq(testLinks.testSymbolId, ts.id))
      .innerJoin(tg, eq(testLinks.targetSymbolId, tg.id))
      .innerJoin(tfile, eq(ts.fileId, tfile.id))
      .where(and(inArray(testLinks.targetSymbolId, targetIds), eq(testLinks.projectId, projectId)))
      .orderBy(desc(testLinks.score))
      .limit(200);
    const viaIds = rows.map((r) => r.viaSymbolId).filter((x): x is number => x !== null);
    const viaMap = new Map<number, string>();
    if (viaIds.length) {
      for (const v of await db.select({ id: symbols.id, name: symbols.qualifiedName }).from(symbols).where(inArray(symbols.id, viaIds))) viaMap.set(v.id, v.name);
    }
    for (const r of rows) {
      tests.push({
        direction: "covered-by",
        otherSymbolId: r.otherSymbolId,
        otherName: r.otherName,
        otherKind: r.otherKind,
        filePath: r.filePath,
        line: r.line,
        targetSymbolId: r.targetSymbolId,
        targetName: r.targetName,
        method: r.method as TestLinkView["method"],
        confidence: r.confidence as TestLinkView["confidence"],
        score: r.score,
        reason: r.reason,
        via: r.viaSymbolId !== null ? { id: r.viaSymbolId, name: viaMap.get(r.viaSymbolId) ?? "?" } : null,
      });
    }
  }

  const summary = buildStaticSummary({
    kind: sym.kind as SymbolDetail["symbol"]["kind"],
    name: sym.name,
    qualifiedName: sym.qualifiedName,
    signature: sym.signature,
    params: sym.params,
    decorators: sym.decorators,
    docstring: sym.docstring,
    returnType: sym.returnType,
    bases: sym.bases,
    isAsync: sym.isAsync,
    isGenerator: sym.isGenerator,
    startLine: sym.startLine,
    endLine: sym.endLine,
    metrics: sym.metrics,
    filePath: file.path,
    childCount: children.length,
    calls: outgoing.map((o) => ({ callee: o.calleeText, resolution: o.resolution, targetName: o.targets[0]?.name ?? null })),
    testCount: sym.kind === "test" ? 0 : new Set(tests.map((t) => t.otherSymbolId)).size,
  });

  const ai = getAiPublicStatus();
  const explanations: Partial<Record<ExplanationBackend, ExplanationResult>> = {};
  const cachedRows = await db.select().from(symbolExplanations).where(eq(symbolExplanations.symbolId, sym.id)).orderBy(desc(symbolExplanations.generatedAt));
  let currentFingerprint: string | undefined;
  for (const row of cachedRows) {
    if (row.backend !== "api" && row.backend !== "agent") continue;
    if (explanations[row.backend]) continue;
    if (ai.backends[row.backend].available && !explanationMatchesConfig(row.configKey, explanationConfigKey(row.backend))) continue;
    const savedFingerprint = storedExplanationFingerprint(row.configKey);
    if (savedFingerprint) {
      currentFingerprint ??= fingerprintExplanation({ symbol: sym, filePath: file.path, language: file.language, source: file.content.slice(sym.startIndex, sym.endIndex), calls: outgoing });
      if (savedFingerprint !== currentFingerprint) continue;
    }
    explanations[row.backend] = { explanation: row.content, model: row.model, generatedAt: row.generatedAt.toISOString(), relativeLines: savedFingerprint !== null };
  }
  // Preserve explanations generated before backend-specific caching was introduced.
  if (!cachedRows.length && sym.aiExplanation) {
    explanations.api = { explanation: sym.aiExplanation, model: sym.aiModel, generatedAt: sym.aiGeneratedAt?.toISOString() ?? null };
  }
  return {
    symbol: {
      id: sym.id,
      fileId: sym.fileId,
      parentId: sym.parentId,
      kind: sym.kind as SymbolDetail["symbol"]["kind"],
      name: sym.name,
      qualifiedName: sym.qualifiedName,
      container: sym.container,
      signature: sym.signature,
      params: sym.params,
      decorators: sym.decorators,
      docstring: sym.docstring,
      returnType: sym.returnType,
      bases: sym.bases,
      isAsync: sym.isAsync,
      isGenerator: sym.isGenerator,
      isTest: sym.isTest,
      startLine: sym.startLine,
      startCol: sym.startCol,
      endLine: sym.endLine,
      endCol: sym.endCol,
      metrics: sym.metrics,
    },
    file: {
      id: file.id,
      path: file.path,
      language: file.language,
      content: file.content,
      isTest: file.isTest,
      hasSyntaxErrors: file.hasSyntaxErrors,
      imports: file.imports,
    },
    parent,
    children,
    summary,
    ai: { ...ai, explanations },
    outgoing,
    incoming,
    tests,
  };
}

/** 重新解析所属文件，生成单方法流程图与关键变量（按需计算） */
export async function getAnalysis(projectId: number, symbolId: number): Promise<AnalysisResult | null> {
  const [sym] = await db
    .select()
    .from(symbols)
    .where(and(eq(symbols.id, symbolId), eq(symbols.projectId, projectId)))
    .limit(1);
  if (!sym) return null;
  const [file] = await db.select().from(files).where(eq(files.id, sym.fileId)).limit(1);
  if (!file) return null;
  const notes: string[] = [];
  if ((sym.kind === "element" || sym.kind === "property")) return { flow: null, variables: [], notes: ["此节点是文档结构，请从左侧展开子节点并查看讲解；不生成执行流程图或变量分析。"] };
  if (sym.kind === "class") {
    return { flow: null, variables: [], notes: ["类本身没有单方法流程图，请在左侧选择其方法。"] };
  }
  const m = pluginForPath(file.path);
  const plugin = m?.plugin ?? pluginById(file.language);
  if (!m || !plugin) return { flow: null, variables: [], notes: ["该语言暂无分析插件。"] };
  notes.push(...plugin.analysisNotes ?? []);
  const tree = await parseSource(m.grammar, file.content);
  if (!tree) return { flow: null, variables: [], notes: ["文件解析超时。"] };
  try {
    const def = findNodeByRange(tree.rootNode, sym.defStartIndex, sym.defEndIndex);
    if (!def) return { flow: null, variables: [], notes: ["无法在语法树中重新定位该方法。"] };
    const ir = plugin.flowIR(def, file.content);
    const flow = buildFlowGraph(ir, sym.name, sym.startLine, sym.endLine);
    if (flow.truncated) notes.push("流程过长，仅展示前 150 个节点。");
    const variables = plugin.analyzeVariables(def, file.content);
    notes.push("变量按名称在方法体内匹配，未做完整作用域分析；回调/嵌套函数内的同名变量可能被合并。");
    notes.push("流程图为语法结构层面的控制流：回调、lambda、推导式内部逻辑不展开；finally 不绘制 return/throw 的穿越路径。");
    return { flow, variables, notes };
  } finally {
    tree.delete();
  }
}

export async function getSymbolForExplain(projectId: number, symbolId: number) {
  const [sym] = await db
    .select()
    .from(symbols)
    .where(and(eq(symbols.id, symbolId), eq(symbols.projectId, projectId)))
    .limit(1);
  if (!sym) return null;
  const [file] = await db.select().from(files).where(eq(files.id, sym.fileId)).limit(1);
  if (!file) return null;
  const outgoing = await db
    .select({ id: refs.id, kind: refs.kind, line: refs.line, col: refs.col, calleeText: refs.calleeText, resolution: refs.resolution })
    .from(refs)
    .where(eq(refs.ownerSymbolId, sym.id))
    .orderBy(asc(refs.line), asc(refs.col), asc(refs.id));
  const names = new Map<number, string>();
  const targets = new Map<number, FingerprintTarget[]>();
  if (outgoing.length) {
    const t = await db
      .select({ refId: refTargets.refId, name: symbols.qualifiedName, filePath: files.path, kind: symbols.kind, confidence: refTargets.confidence })
      .from(refTargets)
      .innerJoin(symbols, eq(refTargets.targetSymbolId, symbols.id))
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(refTargets.projectId, projectId), inArray(refTargets.refId, db.select({ id: refs.id }).from(refs).where(eq(refs.ownerSymbolId, sym.id)))))
      .orderBy(desc(refTargets.score));
    for (const r of t) {
      if (!names.has(r.refId)) names.set(r.refId, r.name);
      const list = targets.get(r.refId) ?? []; list.push(r); targets.set(r.refId, list);
    }
  }
  return { sym, file, calls: outgoing.slice(0, 60).map((o) => ({ ...o, target: names.get(o.id) ?? null })),
    fingerprintCalls: outgoing.map((call) => ({ ...call, targets: targets.get(call.id) ?? [] })) };
}
