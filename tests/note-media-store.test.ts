import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { ensureLearningTables, advanceScanRevision } from "../src/lib/learning-store.ts";
import { ensureFileNoteTable } from "../src/lib/file-note-store.ts";
import { ensureNoteMediaTable, writeNoteMedia, readNoteMedia } from "../src/lib/note-media-store.ts";
import { captureNoteLayout, encodeNoteLayout } from "../src/lib/file-note-rich.ts";

test("note media stay local, project scoped and version checked; images validate bytes; rescans retain assets", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`pragma foreign_keys=on; create table projects(id integer primary key);
      create table files(id integer primary key,project_id integer references projects(id) on delete cascade,path text,content text,language text,line_count integer);
      insert into projects values(1),(2); insert into files values(1,1,'app.ts','','typescript',1);`);
    const db = drizzle(client); await ensureLearningTables(db); await ensureFileNoteTable(db); await ensureNoteMediaTable(db);
    const src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=";
    const input = { fileId: 1, path: "app.ts", revision: 1, src };
    const write = (patch = {}, project = 1) => db.transaction((tx) => writeNoteMedia(tx, project, { ...input, ...patch }), { behavior: "immediate" });
    const saved = await write(), id = saved.url.split("/").pop()!;
    assert.equal((await readNoteMedia(db, 1, id)).data, src);
    await assert.rejects(readNoteMedia(db, 2, id), /不存在/);
    await assert.rejects(write({}, 2), /文件不存在/);
    await assert.rejects(write({ src: "data:image/png;base64,PHNjcmlwdD4=" }), /格式与内容/);
    await assert.rejects(write({ src: "data:image/svg+xml;base64,PHN2Zy8+" }), /只支持/);
    const nodes = captureNoteLayout('<div style="display:grid;grid-template-columns:repeat(4,1fr)"><div>12</div><div>15</div></div>')!;
    const layout = await write({ src: encodeNoteLayout(nodes) }); assert.match(layout.url, /\?layout=1$/);
    await advanceScanRevision(db, 1, true);
    assert.equal((await readNoteMedia(db, 1, id)).data, src);
    await assert.rejects(write(), /重新扫描/);
    await client.execute("delete from projects where id=1");
    await assert.rejects(readNoteMedia(db, 1, id), /不存在/);
  } finally { client.close(); }
});
