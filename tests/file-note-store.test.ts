import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { ensureLearningTables, advanceScanRevision } from "../src/lib/learning-store.ts";
import { ensureFileNoteTable, readFileNote, writeFileNote } from "../src/lib/file-note-store.ts";
import { fileNoteClipboard } from "../src/lib/file-note-clipboard.ts";

test("file notes are isolated, versioned, survive file replacement and cascade with their project", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    await client.executeMultiple(`pragma foreign_keys=on;
      create table projects(id integer primary key);
      create table files(id integer primary key,project_id integer references projects(id) on delete cascade,path text,content text,language text,line_count integer);
      insert into projects values(1),(2);
      insert into files values(1,1,'empty.ts','// no symbols','typescript',1),(2,1,'other.ts','','typescript',1),(3,2,'empty.ts','','typescript',1);`);
    const db = drizzle(client);
    await ensureLearningTables(db); await ensureFileNoteTable(db);
    const write = (input: Record<string, unknown>, file = 1, project = 1) => db.transaction((tx) => writeFileNote(tx, project, file, input), { behavior: "immediate" });
    assert.deepEqual((await readFileNote(db, 1, 1)).note, { body: "", version: 0 });
    const input = { body: "## AI 回复\n\n原文\n```ts\nconst x = 1;\n```", version: 0, revision: 1, path: "empty.ts" };
    const first = await write(input); assert.equal(first.version, 1); assert.equal(first.body, input.body);
    assert.equal((await readFileNote(db, 1, 2)).note.body, "");
    assert.equal((await readFileNote(db, 2, 3)).note.body, "");
    await assert.rejects(readFileNote(db, 2, 1), /文件不存在/);
    await assert.rejects(write(input, 1, 2), /文件不存在/);
    await assert.rejects(write(input), /其他页面修改/);
    const appended = await write({ ...input, version: 1, body: `${input.body}\n\n继续追加` });
    assert.match(appended.body, /继续追加$/); assert.equal(appended.version, 2);
    await client.executeMultiple("delete from files where id=1; insert into files values(10,1,'empty.ts','// changed','typescript',1);");
    await advanceScanRevision(db, 1, true);
    assert.equal((await readFileNote(db, 1, 10)).note.body, appended.body);
    await assert.rejects(write({ ...input, version: 2 }, 10), /重新扫描/);
    await assert.rejects(write({ ...input, version: 2, revision: 2, path: "other.ts" }, 10), /重新扫描/);
    await assert.rejects(write({ ...input, version: 2, revision: 2, body: "中".repeat(11000) }, 10), /最多 32KB/);
    await assert.rejects(write({ ...input, version: -1 }, 10), /无效的笔记版本/);
    const cleared = await write({ ...input, body: "", version: 2, revision: 2 }, 10); assert.equal(cleared.body, "");
    await client.execute("delete from projects where id=1");
    assert.equal((await client.execute("select count(*) as n from file_notes")).rows[0].n, 0);
  } finally { client.close(); }
});

test("plain clipboard content, including code indentation and escapes, is preserved exactly", () => {
  const plain = "## 标题\r\n\r\n```py\r\n    print('\\n')\r\n```\r\n";
  assert.equal(fileNoteClipboard({ getData: (type) => type === "text/plain" ? plain : "<p>wrong</p>" }), plain);
  assert.equal(fileNoteClipboard({ getData: () => "" }), "");
});
