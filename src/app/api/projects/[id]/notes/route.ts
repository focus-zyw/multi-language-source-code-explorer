import { db } from "@/db";
import { parseId } from "@/lib/queries";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";
import { ensureLearningTables, scanRevision, LearningError } from "@/lib/learning-store";
import { ensureNoteTables, listNotes, noteById, viewNote, writeNote } from "@/lib/note-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function prepare(context: Context) {
  const id = parseId((await context.params).id); if (!id) throw new LearningError("无效的项目 ID");
  await ensureLearningTables(db); await ensureNoteTables(db); return id;
}
function failure(error: unknown) {
  if (error instanceof LearningError || error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
  console.error("[notes] request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "笔记操作失败，请保留草稿后重试" }, { status: 500 });
}
export async function GET(request: Request, context: Context) {
  try {
    const id = await prepare(context), query = new URL(request.url).searchParams;
    const page = query.get("page") ?? "0";
    if (!/^\d{1,4}$/.test(page)) throw new LearningError("无效的页码");
    const result = await db.transaction(async (tx) => {
      await scanRevision(tx, id);
      if (query.has("noteId")) return viewNote(tx, id, await noteById(tx, id, query.get("noteId")!));
      return listNotes(tx, id, Number(page), query.get("trash") === "1");
    }, { behavior: "deferred" });
    return Response.json(result);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const input = await readLocalBody(request, 65536), id = await prepare(context);
    return Response.json(await db.transaction(async (tx) => viewNote(tx, id, await writeNote(tx, id, input)), { behavior: "immediate" }));
  } catch (error) { return failure(error); }
}
