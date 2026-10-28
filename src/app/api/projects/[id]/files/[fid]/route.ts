import { db } from "@/db";
import { parseId } from "@/lib/queries";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";
import { ensureLearningTables, LearningError } from "@/lib/learning-store";
import { ensureFileNoteTable, readFileNote, writeFileNote } from "@/lib/file-note-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; fid: string }> };
async function prepare(context: Context) {
  const params = await context.params;
  const id = parseId(params.id), fid = parseId(params.fid);
  if (!id || !fid) throw new LearningError("无效的项目或文件 ID");
  await ensureLearningTables(db);
  await ensureFileNoteTable(db);
  return { id, fid };
}
function failure(error: unknown) {
  if (error instanceof LearningError || error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
  console.error("[file-notes] request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "文件笔记操作失败，请保留草稿后重试" }, { status: 500 });
}
export async function GET(_request: Request, context: Context) {
  try {
    const { id, fid } = await prepare(context);
    return Response.json(await db.transaction((tx) => readFileNote(tx, id, fid), { behavior: "deferred" }));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const input = await readLocalBody(request, 262144);
    const { id, fid } = await prepare(context);
    return Response.json(await db.transaction((tx) => writeFileNote(tx, id, fid, input), { behavior: "immediate" }));
  } catch (error) { return failure(error); }
}
