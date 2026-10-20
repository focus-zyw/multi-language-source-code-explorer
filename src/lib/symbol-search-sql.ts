import { sql, type SQL } from "drizzle-orm";
import type { SearchItem, SymbolSearchInput } from "./symbol-search.ts";

// SQLite has no regexp: scan doc markers and strip qualified annotation prefixes
// to preserve the existing ASCII word-boundary semantics.
const deprecated = sql`(
  exists (with recursive markers(tail) as (
    select lower(coalesce(s.docstring, ''))
    union all select substr(tail, instr(tail, '@deprecated') + 11) from markers where instr(tail, '@deprecated') > 0
  ) select 1 from markers where instr(tail, '@deprecated') > 0 and substr(tail, instr(tail, '@deprecated') + 11, 1) not glob '[a-z0-9_]')
  or exists (with recursive annotations(tail) as (
    select substr(lower(value), 2) from json_each(s.decorators) where substr(value, 1, 1) = '@'
    union all select substr(tail, instr(tail, '.') + 1) from annotations
      where instr(tail, '.') > 0 and substr(tail, 1, instr(tail, '.') - 1) not glob '*[^a-z0-9_]*'
  ) select 1 from annotations where substr(tail, 1, 10) = 'deprecated' and substr(tail, 11, 1) not glob '[a-z0-9_]')
)`;
export interface SearchRow extends Omit<SearchItem, "decorators" | "bases" | "deprecated"> { decorators: string; bases: string; deprecated: number }
export function searchRow(row: SearchRow): SearchItem {
  return { ...row, deprecated: Boolean(row.deprecated), decorators: (JSON.parse(row.decorators) as string[]).slice(0, 8), bases: (JSON.parse(row.bases) as string[]).slice(0, 8) };
}
export function buildSearchQueries(projectId: number, input: SymbolSearchInput) {
  const conditions: SQL[] = [sql`1 = 1`];
  if (input.q) conditions.push(sql`instr(lower(name), ${input.q}) > 0`);
  if (input.path) conditions.push(sql`instr(lower(path), ${input.path}) > 0`);
  if (input.kind) conditions.push(sql`kind = ${input.kind}`);
  if (input.language) conditions.push(sql`language = ${input.language}`);
  if (input.scope === "source") conditions.push(sql`isTest = 0`);
  if (input.scope === "tests") conditions.push(sql`isTest = 1`);
  if (input.deprecated) conditions.push(sql`deprecated = 1`);
  if (input.decorator) conditions.push(sql`exists (select 1 from json_each(decorators) where instr(lower(value), ${input.decorator}) > 0)`);
  if (input.base) conditions.push(sql`exists (select 1 from json_each(bases) where instr(lower(value), ${input.base}) > 0)`);
  const metricColumns = { minCc: "complexity", maxCc: "complexity", minLoc: "loc", maxLoc: "loc", minParams: "params", maxParams: "params", minExactCallers: "exactCallers" } as const;
  const hasMetric = Object.keys(metricColumns).some((key) => input[key as keyof typeof metricColumns] !== null);
  if (input.methodsOnly || hasMetric || ["complexity", "loc", "params", "exactCallers"].includes(input.sort)) conditions.push(sql`kind in ('function', 'method')`);
  for (const key of Object.keys(metricColumns) as (keyof typeof metricColumns)[]) {
    if (input[key] !== null) conditions.push(sql`${sql.identifier(metricColumns[key])} ${sql.raw(key.startsWith("min") ? ">=" : "<=")} ${input[key]}`);
  }
  const cte = sql`with callers as (
    select t.target_symbol_id as target,
      count(distinct case when t.confidence = 'exact' then r.owner_symbol_id end) as exactCallers,
      count(distinct case when t.confidence = 'inferred' then r.owner_symbol_id end) as inferredCallers,
      count(distinct case when t.confidence = 'heuristic' then r.owner_symbol_id end) as candidateCallers
    from ref_targets t inner join refs r on r.id = t.ref_id and r.project_id = ${projectId}
    inner join symbols owner on owner.id = r.owner_symbol_id and owner.project_id = ${projectId}
    where t.project_id = ${projectId} group by t.target_symbol_id
  ), candidates as (
    select s.id, s.qualified_name as name, f.path, f.language, s.start_line as line, s.kind,
      s.decorators, s.bases, ${deprecated} as deprecated, (s.is_test or f.is_test) as isTest,
      case when s.kind in ('function', 'method') then json_extract(s.metrics, '$.complexity') end as complexity,
      case when s.kind in ('function', 'method') then json_extract(s.metrics, '$.loc') end as loc,
      case when s.kind in ('function', 'method') then json_extract(s.metrics, '$.params') end as params,
      coalesce(c.exactCallers, 0) as exactCallers, coalesce(c.inferredCallers, 0) as inferredCallers,
      coalesce(c.candidateCallers, 0) as candidateCallers
    from symbols s inner join files f on f.id = s.file_id and f.project_id = ${projectId}
    left join callers c on c.target = s.id where s.project_id = ${projectId}
  ), filtered as (select * from candidates where ${sql.join(conditions, sql` and `)})`;
  const sortColumn = sql.identifier(input.sort), direction = sql.raw(input.order === "desc" ? "desc" : "asc");
  return {
    count: sql`${cte} select count(*) as total from filtered`,
    items: sql`${cte} select id, name, path, language, line, kind, decorators, bases, deprecated,
      complexity, loc, params, exactCallers, inferredCallers, candidateCallers from filtered
      order by ${sortColumn} ${direction}, path collate binary asc, line asc, id asc limit 40 offset ${input.page * 40}`,
  };
}
