import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { isLearningAnchor, type AnchorResolution, type BookmarkView, type LearningAnchor } from "./learning-types.ts";

type Database = LibSQLDatabase;
type Reader = Pick<Database, "all" | "run">;
const initialized = new WeakMap<Database, Promise<void>>();
export class LearningError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Additive migration; never alters or replaces existing source tables. */
export function ensureLearningTables(db: Database) {
  let ready = initialized.get(db);
  if (!ready) {
    ready = (async () => {
      await db.run(sql`create table if not exists project_scan_versions (
        project_id integer primary key references projects(id) on delete cascade,
        revision integer not null default 1)`);
      await db.run(sql`create table if not exists learning_bookmarks (
        id text primary key, project_id integer not null references projects(id) on delete cascade,
        anchor_key text not null, anchor text not null, created_at integer not null,
        unique(project_id, anchor_key))`);
    })().catch((error) => { initialized.delete(db); throw error; });
    initialized.set(db, ready);
  }
  return ready;
}

export async function advanceScanRevision(tx: Reader, projectId: number, replacing: boolean) {
  // Legacy projects without a row already represent revision 1.
  await tx.run(sql`insert into project_scan_versions(project_id, revision) values (${projectId}, ${replacing ? 2 : 1})
    on conflict(project_id) do update set revision = revision + 1`);
}
export async function scanRevision(tx: Reader, projectId: number) {
  const [project] = await tx.all<{ revision: number }>(sql`select coalesce(v.revision, 1) as revision from projects p
    left join project_scan_versions v on v.project_id = p.id where p.id = ${projectId}`);
  if (!project) throw new LearningError("项目不存在", 404);
  return project.revision;
}
interface Candidate { id: number; line: number; source: string }
const hashSource = (value: string) => createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex");

export function resolveLearningAnchor(anchor: LearningAnchor, candidates: Candidate[]): AnchorResolution {
  if (!candidates.length) return { status: "missing", freshness: "unknown", symbolId: null, line: null };
  const same = candidates.filter((candidate) => hashSource(candidate.source) === anchor.hash);
  const match = same.length === 1 ? same[0] : anchor.unique && candidates.length === 1 ? candidates[0] : null;
  if (!match) return { status: "ambiguous", freshness: "unknown", symbolId: null, line: null };
  return { status: "resolved", freshness: hashSource(match.source) === anchor.hash ? "unchanged" : "changed", symbolId: match.id, line: match.line };
}
async function candidates(tx: Reader, projectId: number, anchor: LearningAnchor) {
  // SQLite substr counts Unicode code points; stored offsets count UTF-16 code units.
  // Slice in JS so emoji before a method cannot corrupt its source fingerprint.
  return tx.all<{ id: number; line: number; content: string; start: number; end: number }>(sql`
    select s.id, s.start_line as line, f.content, s.start_index as start, s.end_index as end
    from symbols s join files f on f.id = s.file_id and f.project_id = ${projectId}
    where s.project_id = ${projectId} and f.path = ${anchor.path} and f.language = ${anchor.language}
      and s.kind = ${anchor.kind} and s.qualified_name = ${anchor.name} limit 201`);
}
export async function resolveAnchor(tx: Reader, projectId: number, value: unknown) {
  if (!isLearningAnchor(value)) throw new LearningError("无效的阅读定位信息");
  const rows = await candidates(tx, projectId, value);
  if (rows.length > 200) return { status: "ambiguous", freshness: "unknown", symbolId: null, line: null } satisfies AnchorResolution;
  return resolveLearningAnchor(value, rows.map((r) => ({ id: r.id, line: r.line, source: r.content.slice(r.start, r.end) })));
}
export async function captureAnchor(tx: Reader, projectId: number, symbolId: number): Promise<LearningAnchor> {
  const [row] = await tx.all<{ path: string; language: string; kind: string; name: string; content: string; start: number; end: number }>(sql`
    select f.path, f.language, s.kind, s.qualified_name as name, f.content, s.start_index as start, s.end_index as end
    from symbols s join files f on f.id = s.file_id and f.project_id = ${projectId}
    where s.id = ${symbolId} and s.project_id = ${projectId}`);
  if (!row) throw new LearningError("节点不存在，请刷新后重试", 404);
  const anchor: LearningAnchor = { version: 1, path: row.path, language: row.language, kind: row.kind, name: row.name,
    hash: hashSource(row.content.slice(row.start, row.end)), unique: false };
  anchor.unique = (await candidates(tx, projectId, anchor)).length === 1;
  return anchor;
}
export async function listBookmarks(tx: Reader, projectId: number): Promise<BookmarkView[]> {
  const rows = await tx.all<{ id: string; anchor: string }>(sql`select id, anchor from learning_bookmarks where project_id = ${projectId} order by created_at desc, id limit 200`);
  const result: BookmarkView[] = [];
  for (const row of rows) {
    const anchor = JSON.parse(row.anchor) as LearningAnchor;
    result.push({ id: row.id, anchor, ...await resolveAnchor(tx, projectId, anchor) });
  }
  return result;
}
export async function addBookmark(tx: Reader, projectId: number, symbolId: number, expectedRevision: unknown) {
  const revision = await scanRevision(tx, projectId);
  if (expectedRevision !== revision) throw new LearningError("源码快照已变化，请刷新后再收藏", 409);
  const anchor = await captureAnchor(tx, projectId, symbolId);
  if ((await resolveAnchor(tx, projectId, anchor)).status !== "resolved") throw new LearningError("同名节点的源码也完全相同，暂时无法建立唯一书签", 409);
  // 候选数量变化可能改变 unique / anchor_key，但已经解析到同一节点的书签仍是同一个收藏。
  const bookmarks = await listBookmarks(tx, projectId);
  const sameTarget = bookmarks.find((bookmark) => bookmark.symbolId === symbolId);
  if (sameTarget) return sameTarget.id;
  const key = hashSource(JSON.stringify([anchor.path, anchor.language, anchor.kind, anchor.name, anchor.unique ? null : anchor.hash]));
  const [existing] = await tx.all<{ id: string }>(sql`select id from learning_bookmarks where project_id = ${projectId} and anchor_key = ${key}`);
  if (existing) return existing.id;
  const [count] = await tx.all<{ count: number }>(sql`select count(*) as count from learning_bookmarks where project_id = ${projectId}`);
  if (count.count >= 200) throw new LearningError("每个项目最多保存 200 个书签，请先整理已有书签", 409);
  const id = randomUUID();
  await tx.run(sql`insert into learning_bookmarks(id, project_id, anchor_key, anchor, created_at)
    values (${id}, ${projectId}, ${key}, ${JSON.stringify(anchor)}, ${Date.now()})`);
  return id;
}
