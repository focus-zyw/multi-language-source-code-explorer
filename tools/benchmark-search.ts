// Isolated in-memory benchmark; never opens the application's database.
import { performance } from "node:perf_hooks";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { readSymbolSearch } from "../src/lib/symbol-search.ts";
import { buildSearchQueries } from "../src/lib/symbol-search-sql.ts";

const client = createClient({ url: ":memory:" });
try {
  await client.executeMultiple(`
    create table files(id integer primary key, project_id integer, path text, language text, is_test integer);
    create table symbols(id integer primary key, project_id integer, file_id integer, kind text, name text, qualified_name text, start_line integer, is_test integer, decorators text, bases text, docstring text, metrics text);
    create table refs(id integer primary key, project_id integer, owner_symbol_id integer);
    create table ref_targets(ref_id integer, project_id integer, target_symbol_id integer, confidence text);
    create index files_project_idx on files(project_id);
    create index symbols_project_idx on symbols(project_id);
    create index symbols_file_idx on symbols(file_id);
    create index symbols_name_idx on symbols(project_id, name);
    create index refs_owner_idx on refs(owner_symbol_id);
    create index refs_project_idx on refs(project_id);
    create index ref_targets_ref_idx on ref_targets(ref_id);
    create index ref_targets_target_idx on ref_targets(target_symbol_id);
    insert into files values(1,1,'src/service.ts','typescript',0);
    with recursive n(i) as (select 1 union all select i+1 from n where i<8000)
      insert into symbols select i,1,1,'function','service'||i,'service'||i,i,0,'[]','[]',null,'{"complexity":3,"loc":10,"params":1}' from n;
    with recursive n(i) as (select 1 union all select i+1 from n where i<100000)
      insert into refs select i,1,(i % 8000)+1 from n;
    insert into ref_targets select id,1,((id * 17) % 8000)+1,
      case id % 3 when 0 then 'exact' when 1 then 'inferred' else 'heuristic' end from refs;
  `);
  const db = drizzle(client);
  const query = (suffix: string) => buildSearchQueries(1, readSymbolSearch(new URLSearchParams(`q=service7999&methodsOnly=1${suffix}`)));
  const fast = query("");
  // A zero threshold retains all methods but forces the original full caller aggregation.
  const full = query("&minExactCallers=0");
  const measure = async (statement: typeof fast.count) => {
    await db.all(statement);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      await db.all(statement);
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[3].toFixed(2);
  };
  const fastCount = await db.all(fast.count), fullCount = await db.all(full.count);
  const fastItems = await db.all(fast.items), fullItems = await db.all(full.items);
  if (JSON.stringify(fastCount) !== JSON.stringify(fullCount) || JSON.stringify(fastItems) !== JSON.stringify(fullItems)) throw new Error("Search results differ");
  const plan = await db.all<{ detail: string }>(sql`explain query plan ${fast.items}`);
  console.log("Page-local query plan:", plan.map((row) => row.detail).join("\n"));
  console.log(`Median milliseconds (7 runs): count ${await measure(fast.count)} vs full ${await measure(full.count)}; items ${await measure(fast.items)} vs full ${await measure(full.items)}`);
} finally {
  client.close();
}
