import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import { ensureLearningTables, scanRevision, advanceScanRevision, captureAnchor, resolveAnchor, addBookmark, listBookmarks } from "../src/lib/learning-store.ts";
import { readReadingPosition, isLearningAnchor, restoredReadingParams, type ReadingPosition } from "../src/lib/learning-types.ts";

async function fixture() {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(`pragma foreign_keys=on;
    create table projects(id integer primary key);
    create table files(id integer primary key,project_id integer references projects(id) on delete cascade,path text,language text,content text);
    create table symbols(id integer primary key,project_id integer references projects(id) on delete cascade,file_id integer references files(id) on delete cascade,kind text,qualified_name text,start_line integer,start_index integer,end_index integer);
    insert into projects values (1),(2);
  `);
  const db = drizzle(client); await ensureLearningTables(db);
  const source = "// 😀\nfunction foo() { return 1; }";
  await client.execute({ sql: "insert into files values (1,1,'app.ts','typescript',?)", args: [source] });
  await client.execute({ sql: "insert into symbols values (1,1,1,'function','foo',2,?,?)", args: [source.indexOf("function"), source.length] });
  return { client, db, source };
}
test("additive initialization, idempotent bookmarks, ownership and UTF-16 fingerprints", async () => {
  const f = await fixture(); try {
    await Promise.all([ensureLearningTables(f.db), ensureLearningTables(f.db)]);
    assert.equal(await scanRevision(f.db, 1), 1);
    const anchor = await captureAnchor(f.db, 1, 1);
    assert.ok(isLearningAnchor(anchor));
    assert.equal((await resolveAnchor(f.db, 1, anchor)).freshness, "unchanged");
    const first = await addBookmark(f.db, 1, 1, 1);
    assert.equal(await addBookmark(f.db, 1, 1, 1), first);
    assert.equal((await listBookmarks(f.db, 1)).length, 1);
    assert.equal((await listBookmarks(f.db, 2)).length, 0);
    await assert.rejects(captureAnchor(f.db, 2, 1));
    await assert.rejects(addBookmark(f.db, 1, 1, 99), /快照已变化/);
    await assert.rejects(scanRevision(f.db, 99), /项目不存在/);
  } finally { f.client.close(); }
});
test("rescans retain bookmarks and rebind line shifts, preserve changed/missing/ambiguous states", async () => {
  const f = await fixture(); try {
    const anchor = await captureAnchor(f.db, 1, 1); await addBookmark(f.db, 1, 1, 1);
    const shift = "// inserted\n" + f.source;
    await f.client.execute({ sql: "update files set content=? where id=1", args: [shift] });
    await f.client.execute({ sql: "update symbols set id=10,start_line=3,start_index=?,end_index=? where id=1", args: [shift.indexOf("function"), shift.length] });
    await advanceScanRevision(f.db, 1, true); assert.equal(await scanRevision(f.db, 1), 2);
    assert.deepEqual(await resolveAnchor(f.db, 1, anchor), { status: "resolved", freshness: "unchanged", symbolId: 10, line: 3 });
    await f.client.execute({ sql: "update files set content=? where id=1", args: [shift.replace("return 1", "return 2")] });
    assert.equal((await listBookmarks(f.db, 1))[0].freshness, "changed");
    await f.client.execute("insert into symbols select 11,project_id,file_id,kind,qualified_name,start_line,start_index,end_index from symbols where id=10");
    assert.equal((await resolveAnchor(f.db, 1, anchor)).status, "ambiguous");
    await f.client.execute("delete from files where id=1");
    assert.equal((await listBookmarks(f.db, 1))[0].status, "missing");
    await f.client.execute("delete from projects where id=1"); assert.equal((await listBookmarks(f.db, 1)).length, 0);
  } finally { f.client.close(); }
});

test("bookmark identity survives changes in the number of same-name candidates", async () => {
  const f = await fixture(); try {
    const other = "function foo() { return 2; }";
    await f.client.execute({ sql: "insert into files values (2,1,'app.ts','typescript',?)", args: [other] });
    await f.client.execute({ sql: "insert into symbols values (2,1,2,'function','foo',1,0,?)", args: [other.length] });
    const first = await addBookmark(f.db, 1, 1, 1);
    await f.client.execute("delete from files where id=2");
    await advanceScanRevision(f.db, 1, true);
    assert.equal(await addBookmark(f.db, 1, 1, 2), first);
    assert.equal((await listBookmarks(f.db, 1)).length, 1);
  } finally { f.client.close(); }
});
test("failed replacement rolls back revision and analysis, identical ambiguous copies do not merge", async () => {
  const f = await fixture(); try {
    await f.client.execute("insert into symbols select 2,project_id,file_id,kind,qualified_name,start_line,start_index,end_index from symbols where id=1");
    const anchor = await captureAnchor(f.db, 1, 1); assert.equal(anchor.unique, false);
    assert.equal((await resolveAnchor(f.db, 1, anchor)).status, "ambiguous");
    await assert.rejects(f.db.transaction(async (tx) => { await advanceScanRevision(tx, 1, true); await tx.run(sql`delete from files where id=1`); throw new Error("rollback"); }));
    assert.equal(await scanRevision(f.db, 1), 1);
    assert.equal((await resolveAnchor(f.db, 1, anchor)).status, "ambiguous");
  } finally { f.client.close(); }
});
test("local reading state validates version, project identity and allowed navigation values", async () => {
  const f = await fixture(); try {
    const selected = await captureAnchor(f.db, 1, 1);
    const position = { version: 1, projectCreatedAt: "created", revision: 1, selected, root: selected, view: "explore", direction: "incoming", tab: "vars", mode: "file" };
    const restored = restoredReadingParams(new URLSearchParams("ai=api&search.q=foo"), 2, 1, { ...position, view: "source" } as ReadingPosition);
    assert.equal(restored.get("root"), "1");
    assert.equal(restored.get("s"), "2");
    assert.equal(restored.get("view"), null);
    assert.equal(restored.get("direction"), "incoming");
    assert.equal(restored.get("ai"), "api");
    assert.equal(restored.get("search.q"), "foo");
    const missing = restoredReadingParams(restored, 2, null, position as ReadingPosition);
    assert.equal(missing.get("root"), null);
    assert.equal(missing.get("direction"), null);
    assert.deepEqual(readReadingPosition(JSON.stringify(position), "created"), position);
    for (const change of [{ version: 2 }, { revision: -1 }, { tab: "unknown" }, { selected: {} }, { mode: "edit" }]) assert.equal(readReadingPosition(JSON.stringify({ ...position, ...change }), "created"), null);
    assert.equal(readReadingPosition(JSON.stringify(position), "different-project"), null);
    assert.equal(readReadingPosition("broken", "created"), null);
  } finally { f.client.close(); }
});
