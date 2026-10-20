import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import type { SymbolSearchInput, SymbolSearchResult } from "./symbol-search";
import { buildSearchQueries, searchRow, type SearchRow } from "./symbol-search-sql";

export async function getSymbolSearch(projectId: number, input: SymbolSearchInput) {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return null;
    const queries = buildSearchQueries(projectId, input);
    const [count] = await tx.all<{ total: number }>(queries.count);
    const rows = await tx.all<SearchRow>(queries.items);
    return { total: count.total, page: input.page, pageSize: 40, items: rows.map(searchRow) } satisfies SymbolSearchResult;
  }, { behavior: "deferred" });
}
