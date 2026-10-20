import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { files, projects, symbols } from "@/db/schema";
import { searchSymbols, type SymbolSearchInput } from "./symbol-search";

export async function getSymbolSearch(projectId: number, input: SymbolSearchInput) {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return null;
    const fileRows = await tx.select({ id: files.id, path: files.path, language: files.language, isTest: files.isTest }).from(files).where(eq(files.projectId, projectId));
    const symbolRows = await tx.select({ id: symbols.id, fileId: symbols.fileId, kind: symbols.kind, qualifiedName: symbols.qualifiedName,
      startLine: symbols.startLine, isTest: symbols.isTest, decorators: symbols.decorators, bases: symbols.bases, docstring: symbols.docstring }).from(symbols).where(eq(symbols.projectId, projectId));
    return searchSymbols(fileRows, symbolRows, input);
  }, { behavior: "deferred" });
}
