export const SEARCH_KINDS = ["function", "method", "class", "test", "element", "property"] as const;
export const SEARCH_LANGUAGES = ["python", "javascript", "typescript", "java", "go", "vue", "html", "json"] as const;
export const SEARCH_SORTS = ["path", "name", "complexity", "loc", "params", "exactCallers"] as const;
export const SEARCH_NUMBERS = ["minCc", "maxCc", "minLoc", "maxLoc", "minParams", "maxParams", "minExactCallers"] as const;
export const SEARCH_FIELDS = ["q", "path", "kind", "language", "decorator", "base", "deprecated", "scope", "page", "sort", "order", "methodsOnly", ...SEARCH_NUMBERS] as const;
export type SearchSort = typeof SEARCH_SORTS[number];
export type SymbolSearchInput = {
  q: string; path: string; kind: string; language: string; decorator: string; base: string;
  deprecated: boolean; methodsOnly: boolean; scope: string; page: number; sort: SearchSort; order: "asc" | "desc";
} & Record<typeof SEARCH_NUMBERS[number], number | null>;
export interface SearchItem {
  id: number; name: string; path: string; language: string; line: number; kind: string;
  decorators: string[]; bases: string[]; deprecated: boolean;
  complexity: number | null; loc: number | null; params: number | null;
  exactCallers: number; inferredCallers: number; candidateCallers: number;
}
export interface SymbolSearchResult { total: number; page: number; pageSize: number; items: SearchItem[] }
export class SearchInputError extends Error {}

export function readSymbolSearch(params: URLSearchParams): SymbolSearchInput {
  const text = (key: string, limit = 200) => { const value = params.get(key)?.trim() ?? ""; if (value.length > limit) throw new SearchInputError(`${key} 筛选文本过长`); return value.toLowerCase(); };
  const kind = text("kind"), language = text("language"), scope = text("scope") || "all", page = params.get("page") ?? "0";
  if (kind && !(SEARCH_KINDS as readonly string[]).includes(kind)) throw new SearchInputError("不支持的符号类型");
  if (language && !(SEARCH_LANGUAGES as readonly string[]).includes(language)) throw new SearchInputError("不支持的语言");
  if (!["all", "source", "tests"].includes(scope)) throw new SearchInputError("不支持的搜索范围");
  if (!/^\d{1,5}$/.test(page)) throw new SearchInputError("无效的搜索页码");
  for (const key of ["deprecated", "methodsOnly"]) if (params.has(key) && !["0", "1"].includes(params.get(key)!)) throw new SearchInputError(`无效的 ${key} 筛选值`);
  const sort = params.get("sort") || "path", order = params.get("order") || "asc";
  if (!(SEARCH_SORTS as readonly string[]).includes(sort) || !["asc", "desc"].includes(order)) throw new SearchInputError("无效的搜索排序");
  const numbers = {} as Record<typeof SEARCH_NUMBERS[number], number | null>;
  for (const key of SEARCH_NUMBERS) {
    const value = params.get(key);
    if (value && !/^\d{1,7}$/.test(value)) throw new SearchInputError(`${key} 必须是非负整数（最多 7 位）`);
    numbers[key] = value ? Number(value) : null;
  }
  for (const [min, max] of [["minCc", "maxCc"], ["minLoc", "maxLoc"], ["minParams", "maxParams"]] as const) {
    if (numbers[min] !== null && numbers[max] !== null && numbers[min]! > numbers[max]!) throw new SearchInputError("筛选下限不能大于上限");
  }
  return { q: text("q"), path: text("path"), kind, language, scope, decorator: text("decorator", 100), base: text("base", 100), deprecated: params.get("deprecated") === "1", methodsOnly: params.get("methodsOnly") === "1", page: Number(page), sort: sort as SearchSort, order: order as "asc" | "desc", ...numbers };
}

/** Workspace owns URL writes; search only owns its namespaced parameters. */
export function searchFromWorkspace(params: URLSearchParams): string {
  const search = new URLSearchParams();
  for (const key of SEARCH_FIELDS) { const value = params.get(`search.${key}`); if (value !== null) search.set(key, value); }
  return search.toString();
}
export function mergeWorkspaceSearch(current: URLSearchParams, request: string): URLSearchParams {
  const next = new URLSearchParams(current), search = new URLSearchParams(request);
  for (const key of SEARCH_FIELDS) { next.delete(`search.${key}`); const value = search.get(key); if (value !== null && value !== "") next.set(`search.${key}`, value); }
  next.set("view", "explore"); next.set("root", "project"); next.set("overview", "search");
  return next;
}
