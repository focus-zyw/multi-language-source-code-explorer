import { db } from "@/db";
import { parseId } from "@/lib/queries";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";
import { ensureLearningTables, LearningError } from "@/lib/learning-store";
import { ensureFileNoteTable } from "@/lib/file-note-store";
import { ensureNoteMediaTable, writeNoteMedia } from "@/lib/note-media-store";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const input = await readLocalBody(request, 3 * 1024 * 1024);
    const id = parseId((await context.params).id);
    if (!id) throw new LearningError("无效的项目 ID");
    await ensureLearningTables(db); await ensureFileNoteTable(db); await ensureNoteMediaTable(db);
    return Response.json(await db.transaction((tx) => writeNoteMedia(tx, id, input), { behavior: "immediate" }));
  } catch (error) {
    if (error instanceof LearningError || error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "保存笔记附件失败，请重试" }, { status: 500 });
  }
}
