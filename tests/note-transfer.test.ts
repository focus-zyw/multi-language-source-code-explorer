import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { ensureLearningTables } from "../src/lib/learning-store.ts";
import { ensureNoteTables, writeNote, noteById, viewNote, listNotes } from "../src/lib/note-store.ts";
import { noteConnections, writeNoteLink } from "../src/lib/note-links.ts";
import { exportNotes, previewNoteImport, importNotes } from "../src/lib/note-transfer.ts";
import { parseNotePackage, notesMarkdown } from "../src/lib/note-transfer-types.ts";
const content = { title: "理解入口", body: "先读分支，再读依赖。", tags: ["入口"], status: "reading" };
async function fixture() {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(`pragma foreign_keys=on; create table projects(id integer primary key);
    create table files(id integer primary key,project_id integer references projects(id) on delete cascade,path text,language text,content text);
    create table symbols(id integer primary key,project_id integer references projects(id) on delete cascade,file_id integer references files(id) on delete cascade,kind text,qualified_name text,start_line integer,start_index integer,end_index integer);
    insert into projects values(1),(2);
    insert into files values(1,1,'app.ts','typescript','function foo() { return 1; }'),(2,2,'app.ts','typescript','function foo() { return 1; }');
    insert into symbols values(1,1,1,'function','foo',1,0,28),(2,2,2,'function','foo',1,0,28);`);
  const db = drizzle(client); await ensureLearningTables(db); await ensureNoteTables(db);
  const write = (input: Record<string, unknown>, project = 1) => db.transaction((tx) => writeNote(tx, project, input), { behavior: "immediate" });
  const create = (patch = {}) => write({ action: "create", id: randomUUID(), content, symbolId: 1, revision: 1, quote: "return 1", ...patch });
  const link = (source: string, target: string, patch = {}, project = 1) => db.transaction((tx) => writeNoteLink(tx, project, { action: "link", source, target, label: "建议先读", ...patch }), { behavior: "immediate" });
  const apply = async (pack: ReturnType<typeof parseNotePackage>, project = 2) => {
    const preview = await previewNoteImport(db, project, pack);
    return db.transaction((tx) => importNotes(tx, project, pack, preview.token), { behavior: "immediate" });
  };
  return { client, db, write, create, link, apply };
}
test("links are directional, scoped, idempotent and retained across trash/restore", async () => {
  const f = await fixture(); try {
    const a = await f.create(), b = await f.create({ content: { ...content, title: "依赖" } });
    await f.link(a.id, b.id); await f.link(a.id, b.id);
    assert.equal((await noteConnections(f.db, 1, a.id)).outgoing.length, 1);
    assert.equal((await noteConnections(f.db, 1, b.id)).incoming[0].id, a.id);
    await assert.rejects(f.link(a.id, b.id, { label: "另一说明" }), /关联已存在/);
    await assert.rejects(f.link(a.id, a.id), /另一篇/);
    await assert.rejects(f.link(a.id, b.id, {}, 2), /不存在/);
    await f.write({ action: "trash", id: b.id, version: 1 });
    assert.equal((await noteConnections(f.db, 1, a.id)).outgoing[0].deleted, true);
    await assert.rejects(f.link(b.id, a.id), /先恢复/);
    await f.write({ action: "restore", id: b.id, version: 2 });
    assert.equal((await noteConnections(f.db, 1, a.id)).outgoing[0].deleted, false);
    await f.link(a.id, b.id, { action: "unlink" }); await f.link(a.id, b.id, { action: "unlink" });
    assert.equal((await noteConnections(f.db, 1, a.id)).outgoing.length, 0);
  } finally { f.client.close(); }
});
test("exports exclude source by default, include only internal links and safely fence quotes", async () => {
  const f = await fixture(); try {
    const a = await f.create(), b = await f.create(); await f.link(a.id, b.id);
    const plain = await exportNotes(f.db, 1, false);
    assert.equal(plain.notes[0].anchor, null); assert.equal(plain.notes[0].quote, null); assert.equal(plain.links.length, 1);
    assert.equal((await exportNotes(f.db, 1, false, [a.id])).links.length, 0);
    assert.equal((await f.apply(plain, 1)).added, 0); // Same-project default backup does not duplicate anchored notes.
    const full = await exportNotes(f.db, 1, true);
    assert.equal(full.notes[0].anchor?.path, "app.ts");
    full.notes[0].quote = { text: "```\n</script>\n```", prefix: "", suffix: "" };
    const md = notesMarkdown(full); assert.match(md, /````\n```\n<\/script>\n```\n````/);
    await assert.rejects(exportNotes(f.db, 2, true, [a.id]), /不存在/);
  } finally { f.client.close(); }
});
test("imports remap links, detach even identical source, skip repeat imports and preserve later edits/trash", async () => {
  const f = await fixture(); try {
    const a = await f.create(), b = await f.create({ content: { ...content, title: "依赖" } }); await f.link(a.id, b.id);
    const pack = await exportNotes(f.db, 1, true), result = await f.apply(pack);
    assert.equal(result.added, 2); assert.equal(result.linksAdded, 1);
    const list = await listNotes(f.db, 2, 0, false), imported = list.items.find((n) => n.title === a.title)!;
    assert.notEqual(imported.id, a.id); assert.equal(imported.anchor, null); assert.equal(imported.resolution, null);
    assert.equal(imported.quoteStartLine, null); assert.equal(imported.importedAnchor?.path, "app.ts");
    assert.equal((await noteConnections(f.db, 2, imported.id)).outgoing[0].title, b.title);
    await f.write({ action: "update", id: imported.id, version: 1, content: { ...content, body: "当前项目的理解" } }, 2);
    assert.equal((await f.apply(pack)).added, 0); assert.equal((await noteById(f.db, 2, imported.id)).body, "当前项目的理解");
    await f.write({ action: "trash", id: imported.id, version: 2 }, 2);
    assert.equal((await f.apply(pack)).added, 0); assert.ok((await noteById(f.db, 2, imported.id)).deletedAt);
    const copy = await f.write({ action: "create", id: randomUUID(), content, copyFrom: imported.id }, 2);
    assert.equal((await viewNote(f.db, 2, copy)).importedAnchor?.path, "app.ts");
    const changed = structuredClone(pack); changed.notes.find((n) => n.id === a.id)!.body = "包中的新版本";
    const changedResult = await f.apply(changed); assert.equal(changedResult.added, 1); assert.equal(changedResult.copies, 1);
    assert.equal((await f.apply(changed)).added, 0);
    await f.client.execute("delete from projects where id=2");
    assert.equal((await f.client.execute("select count(*) as n from learning_note_imports")).rows[0].n, 0);
    assert.equal((await f.client.execute("select count(*) as n from learning_note_evidence")).rows[0].n, 0);
  } finally { f.client.close(); }
});
test("conflicts keep copies, previews detect changes, and failed imports roll back every write", async () => {
  const f = await fixture(); try {
    const a = await f.create(), b = await f.create(); await f.link(a.id, b.id);
    const pack = await exportNotes(f.db, 1, true); pack.notes.find((n) => n.id === a.id)!.body = "冲突文字";
    const preview = await previewNoteImport(f.db, 1, pack); assert.equal(preview.copies, 1); assert.equal(preview.added, 1);
    await f.link(a.id, b.id, { action: "unlink" });
    await assert.rejects(f.db.transaction((tx) => importNotes(tx, 1, pack, preview.token), { behavior: "immediate" }), /重新预览/);
    const result = await f.apply(pack, 1); assert.equal(result.added, 1);
    assert.equal((await noteById(f.db, 1, a.id)).body, content.body);
    assert.equal((await f.apply(pack, 1)).added, 0);
    const cross = await previewNoteImport(f.db, 2, pack);
    await f.client.execute("create trigger fail_link before insert on learning_note_links begin select raise(abort,'forced failure'); end");
    await assert.rejects(f.db.transaction((tx) => importNotes(tx, 2, pack, cross.token), { behavior: "immediate" }), (e: unknown) => e instanceof Error && e.cause instanceof Error && /forced failure/.test(e.cause.message));
    assert.equal((await listNotes(f.db, 2, 0, false)).total, 0);
    assert.equal((await f.client.execute("select count(*) as n from learning_note_imports where project_id=2")).rows[0].n, 0);
  } finally { f.client.close(); }
});
test("packages reject unsupported schema, duplicate IDs, dangling/self links, invalid content and limits", () => {
  const note = { id: randomUUID(), ...content, anchor: null, quote: null, createdAt: 1, updatedAt: 1 };
  const pack = { format: "code-atlas-notes", schemaVersion: 1, notes: [note], links: [] };
  assert.equal(parseNotePackage(pack).notes.length, 1);
  assert.throws(() => parseNotePackage({ ...pack, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => parseNotePackage({ ...pack, notes: [note, note] }), /重复/);
  assert.throws(() => parseNotePackage({ ...pack, links: [{ source: note.id, target: randomUUID(), label: "" }] }), /包内另一篇/);
  assert.throws(() => parseNotePackage({ ...pack, notes: [{ ...note, status: "__proto__" }] }), /内容/);
  assert.throws(() => parseNotePackage({ ...pack, notes: [{ ...note, body: "中".repeat(11000) }] }), /内容/);
  assert.throws(() => parseNotePackage({ ...pack, notes: Array(1001).fill(note) }), /最多/);
  const large = { ...pack, notes: Array.from({ length: 321 }, () => ({ ...note, id: randomUUID(), body: "x".repeat(32768) })) };
  assert.throws(() => parseNotePackage(large), /10MB/);
});
test("preview detects note edits and destination capacity before writing", async () => {
  const f = await fixture(); try {
    const a = await f.create(), pack = await exportNotes(f.db, 1, false);
    const preview = await previewNoteImport(f.db, 1, pack);
    await f.write({ action: "update", id: a.id, version: 1, content: { ...content, body: "较新理解" } });
    await assert.rejects(f.db.transaction((tx) => importNotes(tx, 1, pack, preview.token), { behavior: "immediate" }), /重新预览/);
    await f.client.execute(`with recursive numbers(n) as (select 1 union all select n+1 from numbers where n<1000)
      insert into learning_notes(id,project_id,title,body,tags,status,version,created_at,updated_at)
      select 'capacity-'||n,2,'title','','[]','reading',1,1,1 from numbers`);
    await assert.rejects(previewNoteImport(f.db, 2, pack), /超过每项目 1000/);
  } finally { f.client.close(); }
});
test("additive table initialization preserves a pre-upgrade note without requiring rescan", async () => {
  const client = createClient({ url: ":memory:" }); try {
    const id = randomUUID();
    await client.executeMultiple(`pragma foreign_keys=on; create table projects(id integer primary key); insert into projects values(1);
      create table learning_notes(id text primary key,project_id integer not null references projects(id) on delete cascade,
      title text not null,body text not null,tags text not null,status text not null,version integer not null,
      anchor text,quote text,deleted_at integer,created_at integer not null,updated_at integer not null);`);
    await client.execute({ sql: "insert into learning_notes values(?,1,'旧版笔记','重要理解','[]','reading',7,null,null,null,1,2)", args: [id] });
    const db = drizzle(client); await ensureLearningTables(db); await ensureNoteTables(db); await ensureNoteTables(db);
    const note = await noteById(db, 1, id); assert.equal(note.body, "重要理解"); assert.equal(note.version, 7);
    assert.equal((await noteConnections(db, 1, id)).outgoing.length, 0);
    assert.equal((await exportNotes(db, 1, false)).notes[0].id, id);
  } finally { client.close(); }
});
