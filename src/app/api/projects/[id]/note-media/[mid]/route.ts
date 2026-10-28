import { db } from "@/db";
import { parseId } from "@/lib/queries";
import { LearningError } from "@/lib/learning-store";
import { ensureNoteMediaTable, readNoteMedia } from "@/lib/note-media-store";
import { decodeNoteLayout } from "@/lib/file-note-rich";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string; mid: string }> }) {
  try {
    const { id: raw, mid } = await context.params, id = parseId(raw);
    if (!id) throw new LearningError("无效的项目 ID");
    await ensureNoteMediaTable(db);
    const media = await readNoteMedia(db, id, mid);
    if (media.kind === "layout") return Response.json({ nodes: decodeNoteLayout(media.data) }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(media.data);
    if (!match) throw new LearningError("附件格式无效");
    return new Response(Buffer.from(match[2], "base64"), { headers: { "content-type": match[1], "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
  } catch (error) {
    if (error instanceof LearningError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "读取笔记附件失败" }, { status: 500 });
  }
}
