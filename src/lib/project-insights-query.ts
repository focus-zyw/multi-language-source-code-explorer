import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { files, projects, refs, refTargets, symbols } from "@/db/schema";
import { buildDependencies, buildLearning } from "./project-insights";

export async function getProjectInsights(projectId: number) {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ stats: projects.stats }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return null;
    const fileRows = await tx.select({ id: files.id, path: files.path, language: files.language, isTest: files.isTest, imports: files.imports }).from(files).where(eq(files.projectId, projectId));
    const symbolRows = await tx.select({ id: symbols.id, fileId: symbols.fileId, parentId: symbols.parentId, name: symbols.name, qualifiedName: symbols.qualifiedName,
      kind: symbols.kind, startLine: symbols.startLine, isTest: symbols.isTest, metrics: symbols.metrics, decorators: symbols.decorators, bases: symbols.bases }).from(symbols).where(eq(symbols.projectId, projectId));
    const calls = await tx.select({ target: refTargets.targetSymbolId, owner: refs.ownerSymbolId, confidence: refTargets.confidence }).from(refTargets)
      .innerJoin(refs, eq(refTargets.refId, refs.id)).where(and(eq(refTargets.projectId, projectId), eq(refs.projectId, projectId)));
    const first = new Map<number, number>();
    for (const symbol of [...symbolRows].sort((a, b) => a.startLine - b.startLine || a.id - b.id)) if (!first.has(symbol.fileId)) first.set(symbol.fileId, symbol.id);
    const dependencyFiles = fileRows.map((file) => ({ ...file, symbolId: first.get(file.id) ?? null }));
    return { dependencies: buildDependencies(dependencyFiles), learning: buildLearning(dependencyFiles,
      symbolRows.map(({ metrics, ...symbol }) => ({ ...symbol, complexity: metrics.complexity, loc: metrics.loc })), calls), scan: project.stats?.scanTimings ?? null };
  }, { behavior: "deferred" });
}
