import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { LearningError, scanRevision } from "./learning-store.ts";

type Reader = Pick<LibSQLDatabase, "all" | "run">;
const ready = new WeakMap<LibSQLDatabase, Promise<void>>();
export function ensureFileNoteTable(db: LibSQLDatabase) {
  let pending = ready.get(db);
  if (!pending) {
    pending = db.run(sql`create table if not exists file_notes (
      project_id integer not null references projects(id) on delete cascade,
      path text not null, body text not null, version integer not null,
      primary key(project_id, path))`).then(() => {}).catch((error) => { ready.delete(db); throw error; });
    ready.set(db, pending);
  }
  return pending;
}

export async function readFileNote(tx: Reader, projectId: number, fileId: number) {
  const revision = await scanRevision(tx, projectId);
  const [file] = await tx.all<{ id: number; path: string; content: string; language: string; lineCount: number }>(sql`
    select id, path, content, language, line_count as lineCount from files where project_id=${projectId} and id=${fileId}`);
  if (!file) throw new LearningError("文件不存在，请重新选择文件", 404);
  const [note] = await tx.all<{ body: string; version: number }>(sql`select body, version from file_notes where project_id=${projectId} and path=${file.path}`);
  return { file, revision, note: note ?? { body: "", version: 0 } };
}

export async function writeFileNote(tx: Reader, projectId: number, fileId: number, input: Record<string, unknown>) {
  if (typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") > 32768) throw new LearningError("文件笔记正文最多 32KB");
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 0) throw new LearningError("无效的笔记版本");
  const current = await readFileNote(tx, projectId, fileId);
  if (input.revision !== current.revision || input.path !== current.file.path) throw new LearningError("项目已重新扫描，请保留草稿并刷新后重试", 409);
  if (input.version !== current.note.version) throw new LearningError("笔记已被其他页面修改，请保留草稿后载入已保存版本", 409);
  const version = current.note.version + 1;
  await tx.run(sql`insert into file_notes(project_id,path,body,version) values(${projectId},${current.file.path},${input.body},${version})
    on conflict(project_id,path) do update set body=excluded.body, version=excluded.version`);
  return { body: input.body, version };
}
