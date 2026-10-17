import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { files, projects, refTargets, symbols } from "@/db/schema";
import { identifyProjectEntries } from "./analysis/project-entries";

export async function getProjectEntries(projectId: number) {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  const [fileRows, symbolRows, targetRows] = await Promise.all([
    db.select({ id: files.id, path: files.path, isTest: files.isTest }).from(files).where(eq(files.projectId, projectId)),
    db.select({ id: symbols.id, fileId: symbols.fileId, parentId: symbols.parentId, kind: symbols.kind, name: symbols.name,
      qualifiedName: symbols.qualifiedName, startLine: symbols.startLine, isTest: symbols.isTest, signature: symbols.signature, decorators: symbols.decorators })
      .from(symbols).where(eq(symbols.projectId, projectId)),
    db.selectDistinct({ id: refTargets.targetSymbolId }).from(refTargets).innerJoin(symbols, eq(refTargets.targetSymbolId, symbols.id))
      .where(and(eq(refTargets.projectId, projectId), eq(symbols.projectId, projectId))),
  ]);
  return identifyProjectEntries(fileRows, symbolRows, new Set(targetRows.map((row) => row.id)));
}
