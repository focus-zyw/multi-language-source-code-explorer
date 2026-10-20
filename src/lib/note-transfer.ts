import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { LearningError, scanRevision } from "./learning-store.ts";
import { noteById } from "./note-store.ts";
import { parseNotePackage, type NotePackage, type PortableNote, type PortableLink, type ImportPreview } from "./note-transfer-types.ts";
type Reader = Pick<LibSQLDatabase, "all" | "run">;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fingerprint = (n: PortableNote) => hash({ title: n.title, body: n.body, tags: n.tags, status: n.status, anchor: n.anchor, quote: n.quote });
export async function exportNotes(tx: Reader, projectId: number, includeSource: boolean, ids?: string[]): Promise<NotePackage> {
  await scanRevision(tx, projectId);
  if (ids && (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)) throw new LearningError("导出笔记范围无效");
  const rows = await tx.all<{ id: string; evidence: string | null }>(sql`select n.id,e.anchor as evidence from learning_notes n
    left join learning_note_evidence e on e.note_id=n.id where n.project_id=${projectId} and n.deleted_at is null order by n.id`);
  const selected = ids ? rows.filter((r) => ids.includes(r.id)) : rows;
  if (ids && selected.length !== ids.length) throw new LearningError("所选笔记不存在或位于回收站", 404);
  const notes: PortableNote[] = [];
  for (const row of selected) {
    const n = await noteById(tx, projectId, row.id);
    notes.push({ id: n.id, title: n.title, body: n.body, tags: n.tags, status: n.status, anchor: includeSource ? n.anchor ?? (row.evidence ? JSON.parse(row.evidence) : null) : null,
      quote: includeSource ? n.quote : null, createdAt: n.createdAt, updatedAt: n.updatedAt });
  }
  const included = new Set(notes.map((n) => n.id));
  const links = (await tx.all<PortableLink>(sql`select source_id as source,target_id as target,label from learning_note_links where project_id=${projectId} order by source_id,target_id`))
    .filter((l) => included.has(l.source) && included.has(l.target));
  try { return parseNotePackage({ format: "code-atlas-notes", schemaVersion: 1, notes, links }); }
  catch (e) { throw new LearningError(e instanceof Error ? e.message : "导出包无效"); }
}
interface Snapshot { id: string; version: number; deleted_at: number | null }
interface Mapping { source_id: string; fingerprint: string; note_id: string }
async function planImport(tx: Reader, projectId: number, pack: NotePackage) {
  await scanRevision(tx, projectId);
  const existing = await tx.all<Snapshot>(sql`select id,version,deleted_at from learning_notes where project_id=${projectId} order by id`);
  const mappings = await tx.all<Mapping>(sql`select source_id,fingerprint,note_id from learning_note_imports where project_id=${projectId} order by source_id,fingerprint`);
  const links = await tx.all<PortableLink>(sql`select source_id as source,target_id as target,label from learning_note_links where project_id=${projectId} order by source_id,target_id`);
  const targets = new Map<string, { id: string; add: boolean; fingerprint: string }>();
  let copies = 0;
  for (const n of pack.notes) {
    const fp = fingerprint(n), mapped = mappings.find((m) => m.source_id === n.id && m.fingerprint === fp);
    let id = mapped?.note_id;
    if (!id && existing.some((r) => r.id === n.id)) {
      const current = await noteById(tx, projectId, n.id);
      const [evidence] = await tx.all<{ anchor: string }>(sql`select anchor from learning_note_evidence where note_id=${n.id}`);
      const local = parseNotePackage({ format: "code-atlas-notes", schemaVersion: 1, notes: [{ ...current, anchor: current.anchor ?? (evidence ? JSON.parse(evidence.anchor) : null) }], links: [] });
      // Trash is never restored or overwritten by importing.
      if (local.notes.some((r) => r.id === n.id && fingerprint({ ...r, anchor: n.anchor ? r.anchor : null, quote: n.quote ? r.quote : null }) === fp)) id = n.id;
      else copies++;
    } else if (!id && mappings.some((m) => m.source_id === n.id)) copies++;
    targets.set(n.id, { id: id ?? `new:${n.id}`, add: !id, fingerprint: fp });
  }
  const newLinks = pack.links.filter((l) => {
    const source = targets.get(l.source)!, target = targets.get(l.target)!;
    return ![source, target].some((t) => existing.find((r) => r.id === t.id)?.deleted_at != null) &&
      !links.some((old) => old.source === source.id && old.target === target.id);
  });
  const added = [...targets.values()].filter((t) => t.add).length;
  if (existing.length + added > 1000) throw new LearningError("导入后将超过每项目 1000 篇笔记（含回收站）", 409);
  if (links.length + newLinks.length > 5000) throw new LearningError("导入后将超过每项目 5000 条关联", 409);
  const preview: ImportPreview = { token: hash({ projectId, pack, existing, mappings, links }), added, skipped: pack.notes.length - added, copies,
    linksAdded: newLinks.length, linksSkipped: pack.links.length - newLinks.length, evidence: pack.notes.filter((n) => n.anchor || n.quote).length };
  return { preview, targets, newLinks };
}
export async function previewNoteImport(tx: Reader, projectId: number, pack: NotePackage) { return (await planImport(tx, projectId, pack)).preview; }
// Caller holds an immediate transaction: preview verification, copies, mapping and links commit together.
export async function importNotes(tx: Reader, projectId: number, pack: NotePackage, token: unknown) {
  const { preview, targets, newLinks } = await planImport(tx, projectId, pack);
  if (token !== preview.token) throw new LearningError("笔记或关联已变化，请重新预览后导入", 409);
  for (const n of pack.notes) {
    const t = targets.get(n.id)!;
    if (t.add) {
      t.id = randomUUID();
      await tx.run(sql`insert into learning_notes(id,project_id,title,body,tags,status,version,anchor,quote,created_at,updated_at)
        values(${t.id},${projectId},${n.title},${n.body},${JSON.stringify(n.tags)},${n.status},1,null,${n.quote ? JSON.stringify(n.quote) : null},${n.createdAt},${n.updatedAt})`);
      if (n.anchor) await tx.run(sql`insert into learning_note_evidence(note_id,anchor) values(${t.id},${JSON.stringify(n.anchor)})`);
    }
    await tx.run(sql`insert or ignore into learning_note_imports(project_id,source_id,fingerprint,note_id) values(${projectId},${n.id},${t.fingerprint},${t.id})`);
  }
  for (const l of newLinks) await tx.run(sql`insert into learning_note_links(project_id,source_id,target_id,label) values(${projectId},${targets.get(l.source)!.id},${targets.get(l.target)!.id},${l.label})`);
  return preview;
}
