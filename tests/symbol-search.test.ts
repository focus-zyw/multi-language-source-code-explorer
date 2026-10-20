import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readSymbolSearch, SearchInputError, searchFromWorkspace, mergeWorkspaceSearch } from "../src/lib/symbol-search.ts";
import { buildSearchQueries, searchRow, type SearchRow } from "../src/lib/symbol-search-sql.ts";

async function fixture() {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(`
    create table files(id integer primary key, project_id integer, path text, language text, is_test integer);
    create table symbols(id integer primary key, project_id integer, file_id integer, kind text, qualified_name text, start_line integer, is_test integer, decorators text, bases text, docstring text, metrics text);
    create table refs(id integer primary key, project_id integer, owner_symbol_id integer);
    create table ref_targets(ref_id integer, project_id integer, target_symbol_id integer, confidence text);
    insert into files values (1,1,'src/api/service.ts','typescript',0),(2,1,'tests/service.ts','typescript',1),(3,2,'secret.ts','typescript',0);
  `);
  const db = drizzle(client);
  const add = async (id: number, options: { kind?: string; name?: string; fileId?: number; project?: number; cc?: number; loc?: number; params?: number; doc?: string; decorators?: string[]; bases?: string[]; isTest?: boolean } = {}) => {
    await client.execute({ sql: "insert into symbols values (?,?,?,?,?,?,?,?,?,?,?)", args: [id, options.project ?? 1, options.fileId ?? 1, options.kind ?? "function", options.name ?? `Service${id}`, id, options.isTest ? 1 : 0, JSON.stringify(options.decorators ?? ["@Injectable()"]), JSON.stringify(options.bases ?? ["BaseService<T>"]), options.doc ?? null, JSON.stringify({ complexity: options.cc ?? 3, loc: options.loc ?? 10, params: options.params ?? 1 })] });
  };
  const search = async (query = "", project = 1) => {
    const queries = buildSearchQueries(project, readSymbolSearch(new URLSearchParams(query)));
    const [count] = await db.all<{ total: number }>(queries.count);
    return { total: count.total, items: (await db.all<SearchRow>(queries.items)).map(searchRow) };
  };
  return { client, add, search };
}

test("SQL search combines fields, isolates projects, and treats SQL/wildcard text literally", async () => {
  const f = await fixture(); try {
    await f.add(1, { kind: "class" }); await f.add(2, { bases: [], decorators: [] });
    await f.add(3, { project: 2, fileId: 3 }); await f.add(4, { name: "literal%_' OR 1=1 --" });
    assert.deepEqual((await f.search("q=service&kind=class&language=typescript&decorator=Injectable&base=Base&path=src/api")).items.map((x) => x.id), [1]);
    assert.equal((await f.search("base=UnknownInterface")).total, 0);
    assert.equal((await f.search("q=Service3")).total, 0);
    assert.equal((await f.search("q=" + encodeURIComponent("%_' OR 1=1 --"))).total, 1);
  } finally { f.client.close(); }
});

test("deprecated markers preserve boundaries, qualified annotations and later valid markers", async () => {
  const f = await fixture(); try {
    await f.add(1, { doc: "/** @deprecated_more then @deprecated use newOne */", decorators: [] });
    await f.add(2, { decorators: ["@java.lang.Deprecated"] });
    await f.add(3, { doc: "@deprecated_more", decorators: ["@DeprecatedSoon", "prefix @Deprecated", "@bad-name.Deprecated"] });
    await f.add(4, { decorators: ["@Deprecated()"] });
    assert.deepEqual((await f.search("deprecated=1")).items.map((x) => x.id), [1, 2, 4]);
    assert.equal((await f.search("deprecated=1&decorator=java")).total, 1);
  } finally { f.client.close(); }
});

test("metric boundaries, stable SQL pagination and method scope", async () => {
  const f = await fixture(); try {
    for (let i = 1; i <= 85; i++) await f.add(i, { cc: 10, params: 0 });
    await f.add(90, { kind: "class", cc: 50 }); await f.add(91, { kind: "property", cc: 50 });
    await f.add(92, { fileId: 2 }); await f.add(93, { isTest: true });
    assert.equal((await f.search("minCc=10&maxCc=10&minParams=0&maxParams=0&scope=source")).total, 85);
    const first = await f.search("minCc=10&sort=complexity&order=desc"), second = await f.search("minCc=10&sort=complexity&order=desc&page=1"), third = await f.search("minCc=10&page=2");
    assert.equal(first.items.length, 40); assert.equal(second.items.length, 40); assert.equal(third.items.length, 5);
    assert.equal(new Set([...first.items, ...second.items].map((x) => x.id)).size, 80);
    assert.equal((await f.search("scope=tests")).total, 2);
    assert.equal((await f.search("kind=class&minCc=0")).total, 0);
    assert.equal((await f.search("kind=property")).items[0].complexity, null);
    assert.equal((await f.search("minCc=11")).total, 0);
    assert.equal((await f.search("page=99999")).items.length, 0);
  } finally { f.client.close(); }
});

test("callers deduplicate repeated calls, retain confidence buckets and zero callers", async () => {
  const f = await fixture(); try {
    await f.add(1); await f.add(2); await f.add(3, { fileId: 2 }); await f.add(4, { project: 2, fileId: 3 });
    await f.client.executeMultiple(`insert into refs values (1,1,2),(2,1,2),(3,1,3),(4,2,4);
      insert into ref_targets values (1,1,1,'exact'),(2,1,1,'exact'),(2,1,1,'inferred'),(3,1,1,'exact'),(3,1,1,'heuristic'),(4,2,1,'exact');`);
    const rows = await f.search("minExactCallers=2&sort=exactCallers&order=desc");
    assert.equal(rows.total, 1); assert.equal(rows.items[0].exactCallers, 2);
    assert.equal(rows.items[0].inferredCallers, 1); assert.equal(rows.items[0].candidateCallers, 1);
    assert.equal((await f.search("minExactCallers=0")).total, 3);
    assert.equal((await f.search("minExactCallers=3")).total, 0);
  } finally { f.client.close(); }
});

test("validation rejects invalid ranges, enums and unbounded values", () => {
  for (const input of ["kind=interface", "language=unknown", "scope=unknown", "page=-1", "page=1e2", "deprecated=yes", "minCc=-1", "maxLoc=1.1", "minParams=1e2", "minCc=11&maxCc=10", "minLoc=2&maxLoc=1", "sort=id;drop table symbols", "order=sideways", "methodsOnly=yes", "minExactCallers=10000000", `q=${"x".repeat(201)}`]) assert.throws(() => readSymbolSearch(new URLSearchParams(input)), SearchInputError);
});

test("workspace search round trips conditions without discarding navigation or backend parameters", () => {
  const current = new URLSearchParams("s=42&root=9&backend=agent&custom=kept&search.q=old&search.page=3");
  const next = mergeWorkspaceSearch(current, "minCc=10&sort=complexity&order=desc&page=1");
  assert.equal(next.get("backend"), "agent"); assert.equal(next.get("s"), "42"); assert.equal(next.get("custom"), "kept");
  assert.equal(next.get("root"), "project"); assert.equal(next.has("search.q"), false);
  assert.equal(searchFromWorkspace(next), "page=1&sort=complexity&order=desc&minCc=10");
  assert.equal(searchFromWorkspace(mergeWorkspaceSearch(next, "")), "");
});
