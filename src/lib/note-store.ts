import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { captureAnchor, resolveAnchor, scanRevision, LearningError } from "./learning-store.ts";
import { locateQuote, parseNoteContent, type LearningNote, type NoteQuote, type NoteView } from "./note-types.ts";
type Reader = Pick<LibSQLDatabase, "all" | "run">;
const ready = new WeakMap<LibSQLDatabase, Promise<void>>();
export function ensureNoteTables(db: LibSQLDatabase) {
  let promise = ready.get(db);
  if (!promise) {
    promise = (async () => {
      await db.run(sql`create table if not exists learning_notes (
        id text primary key, project_id integer not null references projects(id) on delete cascade,
        title text not null, body text not null, tags text not null, status text not null,
        version integer not null, anchor text, quote text, deleted_at integer, created_at integer not null, updated_at integer not null)`);
      await db.run(sql`create index if not exists learning_notes_project_idx on learning_notes(project_id, deleted_at, updated_at)`);
      await db.run(sql`create table if not exists learning_note_links (
        project_id integer not null references projects(id) on delete cascade,
        source_id text not null references learning_notes(id) on delete cascade,
        target_id text not null references learning_notes(id) on delete cascade, label text not null,
        primary key(project_id,source_id,target_id))`);
      await db.run(sql`create index if not exists learning_note_links_target_idx on learning_note_links(project_id,target_id)`);
      await db.run(sql`create table if not exists learning_note_evidence (
        note_id text primary key references learning_notes(id) on delete cascade, anchor text not null)`);
      await db.run(sql`create table if not exists learning_note_imports (
        project_id integer not null references projects(id) on delete cascade, source_id text not null,
        fingerprint text not null, note_id text not null references learning_notes(id) on delete cascade,
        primary key(project_id,source_id,fingerprint))`);
    })().catch((error) => { ready.delete(db); throw error; });
    ready.set(db, promise);
  }
  return promise;
}
interface Row { id: string; title: string; body: string; tags: string; status: LearningNote["status"]; version: number; anchor: string | null; quote: string | null; deleted_at: number | null; created_at: number; updated_at: number }
function decode(row: Row): LearningNote {
  return { id: row.id, title: row.title, body: row.body, tags: JSON.parse(row.tags), status: row.status, version: row.version,
    anchor: row.anchor ? JSON.parse(row.anchor) : null, quote: row.quote ? JSON.parse(row.quote) : null,
    deletedAt: row.deleted_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
export async function noteById(tx: Reader, projectId: number, id: string) {
  const [row] = await tx.all<Row>(sql`select * from learning_notes where project_id = ${projectId} and id = ${id}`);
  if (!row) throw new LearningError("笔记不存在", 404);
  return decode(row);
}
async function sourceFor(tx: Reader, projectId: number, symbolId: number) {
  const [row] = await tx.all<{ content: string; start: number; end: number; line: number }>(sql`select f.content, s.start_index as start, s.end_index as end, s.start_line as line
    from symbols s join files f on f.id = s.file_id and f.project_id = ${projectId} where s.project_id = ${projectId} and s.id = ${symbolId}`);
  if (!row) throw new LearningError("引用节点已失效", 409);
  return { source: row.content.slice(row.start, row.end), line: row.line };
}
export async function viewNote(tx: Reader, projectId: number, note: LearningNote): Promise<NoteView> {
  const resolution = note.anchor ? await resolveAnchor(tx, projectId, note.anchor) : null;
  let quoteStartLine: number | null = null, quoteEndLine: number | null = null;
  if (resolution?.symbolId && note.quote) {
    const { source, line } = await sourceFor(tx, projectId, resolution.symbolId);
    const index = locateQuote(source, note.quote);
    if (index !== null) { quoteStartLine = line + source.slice(0, index).split("\n").length - 1; quoteEndLine = quoteStartLine + note.quote.text.split("\n").length - 1; }
  }
  const [evidence] = await tx.all<{ anchor: string }>(sql`select anchor from learning_note_evidence where note_id=${note.id}`);
  return { ...note, resolution, quoteStartLine, quoteEndLine, importedAnchor: evidence ? JSON.parse(evidence.anchor) : null };
}
export async function listNotes(tx: Reader, projectId: number, page: number, trash: boolean) {
  const where = sql`project_id = ${projectId} and ${trash ? sql`deleted_at is not null` : sql`deleted_at is null`}`;
  const [count] = await tx.all<{ total: number }>(sql`select count(*) as total from learning_notes where ${where}`);
  const rows = await tx.all<Row>(sql`select * from learning_notes where ${where} order by updated_at desc, id limit 20 offset ${page * 20}`);
  const items = [];
  for (const row of rows) items.push(await viewNote(tx, projectId, decode(row)));
  return { revision: await scanRevision(tx, projectId), total: count.total, page, items };
}
export async function writeNote(tx: Reader, projectId: number, input: Record<string, unknown>) {
  await scanRevision(tx, projectId);
  if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/i.test(input.id)) throw new LearningError("无效的笔记 ID");
  const id = input.id;
  if (input.action === "create") {
    const content = parseNoteContent(input.content); if (!content) throw new LearningError("标题、正文、标签或学习状态无效（正文最多 32KB）");
    if (input.quote != null && (typeof input.quote !== "string" || !input.quote.trim() || input.quote.length > 6000)) throw new LearningError("代码选区最多 6000 字符");
    const [exists] = await tx.all<{ id: string }>(sql`select id from learning_notes where id = ${id}`);
    if (exists) {
      const note = await noteById(tx, projectId, id);
      if (JSON.stringify({ title: note.title, body: note.body, tags: note.tags, status: note.status }) !== JSON.stringify(content)) throw new LearningError("此创建请求已保存其他内容，请打开已有笔记或另存副本", 409);
      return note;
    }
    const [count] = await tx.all<{ total: number }>(sql`select count(*) as total from learning_notes where project_id = ${projectId}`);
    if (count.total >= 1000) throw new LearningError("每个项目最多保存 1000 篇笔记（含回收站）", 409);
    const copied = typeof input.copyFrom === "string" ? await noteById(tx, projectId, input.copyFrom) : null;
    let anchor = copied?.anchor ?? null, quote: NoteQuote | null = copied?.quote ?? null;
    if (input.symbolId !== undefined && input.symbolId !== null) {
      if (!Number.isSafeInteger(input.symbolId) || Number(input.symbolId) < 1) throw new LearningError("无效的节点 ID");
      if (input.revision === await scanRevision(tx, projectId)) {
        anchor = await captureAnchor(tx, projectId, Number(input.symbolId));
        if (input.quote != null) {
          if (typeof input.quote !== "string" || !input.quote.trim() || input.quote.length > 6000) throw new LearningError("代码选区最多 6000 字符");
          const { source } = await sourceFor(tx, projectId, Number(input.symbolId));
          const index = source.indexOf(input.quote);
          if (index < 0 || source.indexOf(input.quote, index + 1) >= 0) throw new LearningError("选区不在当前节点中或出现多次，请调整选区");
          quote = { text: input.quote, prefix: source.slice(Math.max(0, index - 60), index), suffix: source.slice(index + input.quote.length, index + input.quote.length + 60) };
        }
      } else if (typeof input.quote === "string" && input.quote.length <= 6000) {
        quote = { text: input.quote, prefix: "", suffix: "" };
      } // A rescan during editing must not prevent saving human text or the original quote.
    }
    const now = Date.now();
    await tx.run(sql`insert into learning_notes(id,project_id,title,body,tags,status,version,anchor,quote,created_at,updated_at)
      values (${id},${projectId},${content.title},${content.body},${JSON.stringify(content.tags)},${content.status},1,${anchor ? JSON.stringify(anchor) : null},${quote ? JSON.stringify(quote) : null},${now},${now})`);
    if (copied) await tx.run(sql`insert into learning_note_evidence(note_id,anchor) select ${id},anchor from learning_note_evidence where note_id=${copied.id}`);
    return noteById(tx, projectId, id);
  }
  const old = await noteById(tx, projectId, id);
  if (input.version !== old.version) throw new LearningError("笔记已被其他页面修改，请保留草稿并加载服务器版本", 409);
  if (input.action === "update") {
    if (old.deletedAt !== null) throw new LearningError("请先从回收站恢复笔记", 409);
    const c = parseNoteContent(input.content); if (!c) throw new LearningError("笔记内容无效（正文最多 32KB）");
    await tx.run(sql`update learning_notes set title=${c.title},body=${c.body},tags=${JSON.stringify(c.tags)},status=${c.status},version=version+1,updated_at=${Date.now()} where project_id=${projectId} and id=${id}`);
  } else if (input.action === "trash" || input.action === "restore") {
    await tx.run(sql`update learning_notes set deleted_at=${input.action === "trash" ? Date.now() : null},version=version+1,updated_at=${Date.now()} where project_id=${projectId} and id=${id}`);
  } else throw new LearningError("不支持的笔记操作");
  return noteById(tx, projectId, id);
}
