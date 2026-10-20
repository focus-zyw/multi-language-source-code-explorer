export const SEARCH_KINDS = ["function", "method", "class", "test", "element", "property"] as const;
export const SEARCH_LANGUAGES = ["python", "javascript", "typescript", "java", "go", "vue", "html", "json"] as const;
export interface SymbolSearchInput { q: string; path: string; kind: string; language: string; decorator: string; base: string; deprecated: boolean; scope: string; page: number }
export interface SearchSymbol { id: number; fileId: number; kind: string; qualifiedName: string; startLine: number; isTest: boolean; decorators: string[]; bases: string[]; docstring: string | null }
export interface SearchFile { id: number; path: string; language: string; isTest: boolean }
export interface SymbolSearchResult { total: number; page: number; pageSize: number; items: { id: number; name: string; path: string; language: string; line: number; kind: string; decorators: string[]; bases: string[]; deprecated: boolean }[] }
export class SearchInputError extends Error {}

export function readSymbolSearch(params: URLSearchParams): SymbolSearchInput {
  const text = (key: string, limit = 200) => { const value = params.get(key)?.trim() ?? ""; if (value.length > limit) throw new SearchInputError(`${key} 筛选文本过长`); return value.toLowerCase(); };
  const kind = text("kind"), language = text("language"), scope = text("scope") || "all", page = params.get("page") ?? "0";
  if (kind && !(SEARCH_KINDS as readonly string[]).includes(kind)) throw new SearchInputError("不支持的符号类型");
  if (language && !(SEARCH_LANGUAGES as readonly string[]).includes(language)) throw new SearchInputError("不支持的语言");
  if (!["all", "source", "tests"].includes(scope)) throw new SearchInputError("不支持的搜索范围");
  if (!/^\d{1,5}$/.test(page)) throw new SearchInputError("无效的搜索页码");
  if (params.has("deprecated") && !["0", "1"].includes(params.get("deprecated")!)) throw new SearchInputError("无效的弃用筛选值");
  return { q: text("q"), path: text("path"), kind, language, scope, decorator: text("decorator", 100), base: text("base", 100), deprecated: params.get("deprecated") === "1", page: Number(page) };
}

export function searchSymbols(files: SearchFile[], symbols: SearchSymbol[], input: SymbolSearchInput): SymbolSearchResult {
  const byFile = new Map(files.map((file) => [file.id, file]));
  const items: SymbolSearchResult["items"] = [];
  for (const symbol of symbols) {
    const file = byFile.get(symbol.fileId); if (!file) continue;
    const isTest = file.isTest || symbol.isTest;
    if (input.scope === "source" && isTest || input.scope === "tests" && !isTest) continue;
    if (input.kind && symbol.kind !== input.kind || input.language && file.language !== input.language) continue;
    if (input.q && !symbol.qualifiedName.toLowerCase().includes(input.q)) continue;
    if (input.path && !file.path.toLowerCase().includes(input.path)) continue;
    if (input.decorator && !symbol.decorators.some((value) => value.toLowerCase().includes(input.decorator))) continue;
    if (input.base && !symbol.bases.some((value) => value.toLowerCase().includes(input.base))) continue;
    const deprecated = /@deprecated\b/i.test(symbol.docstring ?? "") || symbol.decorators.some((value) => /^@(?:[\w.]*\.)?deprecated\b/i.test(value));
    if (input.deprecated && !deprecated) continue;
    items.push({ id: symbol.id, name: symbol.qualifiedName, path: file.path, language: file.language, line: symbol.startLine, kind: symbol.kind, decorators: symbol.decorators.slice(0, 8), bases: symbol.bases.slice(0, 8), deprecated });
  }
  items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.id - b.id);
  const pageSize = 40;
  return { total: items.length, page: input.page, pageSize, items: items.slice(input.page * pageSize, (input.page + 1) * pageSize) };
}
