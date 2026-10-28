import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { LearningError } from "./learning-store.ts";
import { readFileNote } from "./file-note-store.ts";
import { decodeNoteLayout, NOTE_IMAGE_MAX_BYTES, RICH_NOTE_PREFIX } from "./file-note-rich.ts";

type Reader = Pick<LibSQLDatabase, "all" | "run">;
const ready = new WeakMap<LibSQLDatabase, Promise<void>>();
export function ensureNoteMediaTable(db: LibSQLDatabase) {
  let pending = ready.get(db);
  if (!pending) {
    pending = db.run(sql`create table if not exists note_media (
      id text primary key, project_id integer not null references projects(id) on delete cascade,
      kind text not null, data text not null)`)
      .then(() => {}).catch((error) => { ready.delete(db); throw error; });
    ready.set(db, pending);
  }
  return pending;
}
export async function readNoteMedia(tx: Reader, projectId: number, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new LearningError("无效的附件 ID");
  const [row] = await tx.all<{ kind: string; data: string }>(sql`select kind,data from note_media where project_id=${projectId} and id=${id}`);
  if (!row) throw new LearningError("附件不存在", 404);
  return row;
}
export async function writeNoteMedia(tx: Reader, projectId: number, input: Record<string, unknown>) {
  if (!Number.isSafeInteger(input.fileId) || typeof input.src !== "string" || input.src.length > 2 * 1024 * 1024) throw new LearningError("无效的笔记附件");
  const current = await readFileNote(tx, projectId, input.fileId as number);
  if (current.revision !== input.revision || current.file.path !== input.path) throw new LearningError("项目已重新扫描，请刷新后再插入附件", 409);
  let kind: string;
  if (input.src.startsWith(RICH_NOTE_PREFIX)) {
    if (!decodeNoteLayout(input.src)) throw new LearningError("富文本布局无效或过大");
    kind = "layout";
  } else {
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.src);
    if (!match) throw new LearningError("只支持 PNG、JPEG、WebP 和 GIF 图片");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > NOTE_IMAGE_MAX_BYTES) throw new LearningError("每张图片最多 1MB");
    const valid = match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : match[1] === "gif" ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new LearningError("图片格式与内容不匹配");
    kind = "image";
  }
  const [usage] = await tx.all<{ size: number; count: number }>(sql`select coalesce(sum(length(data)),0) as size,count(*) as count from note_media where project_id=${projectId}`);
  if (usage.size + input.src.length > 32 * 1024 * 1024 || usage.count >= 1000) throw new LearningError("每个项目的笔记附件最多 32MB、1000 个");
  const id = randomUUID();
  await tx.run(sql`insert into note_media(id,project_id,kind,data) values(${id},${projectId},${kind},${input.src})`);
  return { url: `/api/projects/${projectId}/note-media/${id}${kind === "layout" ? "?layout=1" : ""}` };
}
