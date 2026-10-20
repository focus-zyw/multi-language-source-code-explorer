import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { ensureLearningTables, advanceScanRevision } from "../src/lib/learning-store.ts";
import { ensureNoteTables, writeNote, noteById, viewNote, listNotes } from "../src/lib/note-store.ts";
import { parseNoteContent, locateQuote } from "../src/lib/note-types.ts";
import { readLocalBody } from "../src/lib/ingest/local-request.ts";
const content = { title: "为什么这样设计", body: "**边界**\n<script>alert(1)</script>", tags: ["流程", "流程"], status: "reading" };
async function fixture() {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(`pragma foreign_keys=on;
    create table projects(id integer primary key);
    create table files(id integer primary key,project_id integer references projects(id) on delete cascade,path text,language text,content text);
    create table symbols(id integer primary key,project_id integer references projects(id) on delete cascade,file_id integer references files(id) on delete cascade,kind text,qualified_name text,start_line integer,start_index integer,end_index integer);
    insert into projects values(1),(2);
    insert into files values(1,1,'app.ts','typescript','function foo() { return 1; }');
    insert into symbols values(1,1,1,'function','foo',1,0,28);`);
  const db = drizzle(client); await ensureLearningTables(db); await ensureNoteTables(db);
  const create = (patch = {}) => ({ action: "create", id: randomUUID(), content, symbolId: 1, revision: 1, quote: "return 1", ...patch });
  const write = (input: Record<string, unknown>, project = 1) => db.transaction((tx) => writeNote(tx, project, input), { behavior: "immediate" });
  return { client, db, create, write };
}
test("notes are idempotent, scoped, quoted, versioned and copied without losing code evidence", async () => {
  const f = await fixture(); try {
    const request = f.create(), first = await f.write(request);
    assert.equal((await f.write(request)).id, first.id); assert.deepEqual(first.tags, ["流程"]);
    assert.equal((await viewNote(f.db, 1, first)).quoteStartLine, 1);
    await assert.rejects(f.write({ ...request, content: { ...content, body: "different" } }), /已保存其他内容/);
    const updated = await f.write({ action: "update", id: first.id, version: 1, content: { ...content, body: "本地修改" } });
    assert.equal(updated.version, 2);
    await assert.rejects(f.write({ action: "update", id: first.id, version: 1, content }), /其他页面修改/);
    assert.equal((await noteById(f.db, 1, first.id)).body, "本地修改");
    const copy = await f.write(f.create({ symbolId: undefined, copyFrom: first.id }));
    assert.deepEqual(copy.anchor, first.anchor); assert.deepEqual(copy.quote, first.quote);
    assert.equal((await listNotes(f.db, 2, 0, false)).total, 0);
    await assert.rejects(noteById(f.db, 2, first.id), /不存在/);
    await assert.rejects(f.write({ action: "trash", id: first.id, version: 2 }, 2), /不存在/);
  } finally { f.client.close(); }
});
test("notes survive replacement/deletion, stale saves remain detached and trash is reversible", async () => {
  const f = await fixture(); try {
    const first = await f.write(f.create());
    await f.client.execute("update files set content='function foo() { return 2; }' where id=1");
    await f.client.execute("update symbols set id=10 where id=1"); await advanceScanRevision(f.db, 1, true);
    const viewed = await viewNote(f.db, 1, first);
    assert.equal(viewed.resolution?.freshness, "changed"); assert.equal(viewed.quoteStartLine, null);
    const detached = await f.write(f.create()); assert.equal(detached.anchor, null); assert.equal(detached.quote?.text, "return 1");
    await assert.rejects(f.write(f.create({ quote: "x".repeat(6001) })), /最多 6000/);
    await f.client.execute("delete from files where id=1");
    assert.equal((await viewNote(f.db, 1, first)).resolution?.status, "missing");
    const trashed = await f.write({ action: "trash", id: first.id, version: 1 }); assert.ok(trashed.deletedAt);
    assert.equal((await listNotes(f.db, 1, 0, true)).total, 1);
    await assert.rejects(f.write({ action: "update", id: first.id, version: 2, content }), /先从回收站恢复/);
    const restored = await f.write({ action: "restore", id: first.id, version: 2 }); assert.equal(restored.deletedAt, null); assert.equal(restored.version, 3);
    assert.equal(restored.body, first.body);
    await f.client.execute("delete from projects where id=1");
    assert.equal((await f.client.execute("select count(*) as count from learning_notes")).rows[0].count, 0);
  } finally { f.client.close(); }
});
test("content limits, enum validation and quote ambiguity are explicit", () => {
  assert.equal(parseNoteContent({ ...content, body: "中".repeat(11000) }), null);
  assert.equal(parseNoteContent({ ...content, status: "__proto__" }), null);
  assert.equal(parseNoteContent({ ...content, tags: Array(11).fill("x") }), null);
  assert.equal(parseNoteContent({ ...content, title: " " }), null);
  assert.equal(locateQuote("x x", { text: "x", prefix: "", suffix: "" }), null);
  assert.equal(locateQuote("x x", { text: "x", prefix: "x ", suffix: "" }), 2);
});
test("note requests have a separate bounded body limit and still reject cross-site writes", async () => {
  const request = (origin = "http://localhost") => new Request("http://localhost/api/projects/1/notes", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ body: "x".repeat(9000) }) });
  await assert.rejects(readLocalBody(request()), /过长/);
  assert.equal((await readLocalBody(request(), 65536)).body, "x".repeat(9000));
  await assert.rejects(readLocalBody(request("https://evil.invalid"), 65536), /跨站/);
});
