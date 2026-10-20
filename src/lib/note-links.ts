import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { LearningError, scanRevision } from "./learning-store.ts";
import { noteById } from "./note-store.ts";
import type { NoteConnections } from "./note-types.ts";
type Reader = Pick<LibSQLDatabase, "all" | "run">;
export async function noteConnections(tx: Reader, projectId: number, id: string): Promise<NoteConnections> {
  await scanRevision(tx, projectId); await noteById(tx, projectId, id);
  const edges = async (incoming: boolean) => {
    const rows = await tx.all<{ id: string; title: string; deleted_at: number | null; label: string }>(sql`
      select n.id,n.title,n.deleted_at,l.label from learning_note_links l join learning_notes n
      on n.id=${incoming ? sql`l.source_id` : sql`l.target_id`} and n.project_id=l.project_id
      where l.project_id=${projectId} and ${incoming ? sql`l.target_id` : sql`l.source_id`}=${id} order by n.title,n.id`);
    return rows.map((r) => ({ id: r.id, title: r.title, deleted: r.deleted_at !== null, label: r.label }));
  };
  return { outgoing: await edges(false), incoming: await edges(true), choices: await tx.all<{ id: string; title: string }>(sql`
    select id,title from learning_notes where project_id=${projectId} and deleted_at is null and id<>${id} order by title,id limit 1000`) };
}
export async function writeNoteLink(tx: Reader, projectId: number, input: Record<string, unknown>) {
  await scanRevision(tx, projectId);
  if (typeof input.source !== "string" || typeof input.target !== "string" || input.source === input.target) throw new LearningError("请选择另一篇笔记");
  const source = await noteById(tx, projectId, input.source), target = await noteById(tx, projectId, input.target);
  if (input.action === "unlink") {
    await tx.run(sql`delete from learning_note_links where project_id=${projectId} and source_id=${source.id} and target_id=${target.id}`);
    return;
  }
  if (input.action !== "link" || typeof input.label !== "string" || input.label.length > 200) throw new LearningError("关联说明最多 200 字符");
  if (source.deletedAt !== null || target.deletedAt !== null) throw new LearningError("请先恢复回收站中的笔记", 409);
  const [old] = await tx.all<{ label: string }>(sql`select label from learning_note_links where project_id=${projectId} and source_id=${source.id} and target_id=${target.id}`);
  if (old) {
    if (old.label !== input.label.trim()) throw new LearningError("关联已存在；如需修改说明，请先移除原关联", 409);
    return;
  }
  const [count] = await tx.all<{ total: number }>(sql`select count(*) as total from learning_note_links where project_id=${projectId}`);
  if (count.total >= 5000) throw new LearningError("每个项目最多 5000 条笔记关联", 409);
  await tx.run(sql`insert into learning_note_links(project_id,source_id,target_id,label) values(${projectId},${source.id},${target.id},${input.label.trim()})`);
}
