import { db } from "@/db";
import { parseId } from "@/lib/queries";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";
import { LearningError, ensureLearningTables } from "@/lib/learning-store";
import { ensureNoteTables } from "@/lib/note-store";
import { exportNotes, importNotes, previewNoteImport } from "@/lib/note-transfer";
import { NOTE_PACKAGE_BYTES, notesMarkdown, parseNotePackage } from "@/lib/note-transfer-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function prepare(context: Context) {
  const id = parseId((await context.params).id); if (!id) throw new LearningError("无效的项目 ID");
  await ensureLearningTables(db); await ensureNoteTables(db); return id;
}
function failure(error: unknown) {
  if (error instanceof LearningError || error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
  console.error("[notes-transfer] request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "笔记流转失败，请重试" }, { status: 500 });
}
export async function GET(request: Request, context: Context) {
  try {
    const id = await prepare(context), q = new URL(request.url).searchParams, format = q.get("format") ?? "json";
    if (!["json", "markdown"].includes(format)) throw new LearningError("不支持的导出格式");
    const pack = await db.transaction((tx) => exportNotes(tx, id, q.get("source") === "1", q.has("noteId") ? q.getAll("noteId") : undefined), { behavior: "deferred" });
    const body = format === "json" ? JSON.stringify(pack) : notesMarkdown(pack);
    if (Buffer.byteLength(body) > NOTE_PACKAGE_BYTES) throw new LearningError("导出内容超过 10MB，请在笔记卡片逐篇导出", 413);
    return new Response(body, { headers: { "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="code-atlas-notes-${id}.${format === "json" ? "json" : "md"}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const input = await readLocalBody(request, NOTE_PACKAGE_BYTES + 1024), id = await prepare(context);
    if (input.action !== "preview" && input.action !== "import") throw new LearningError("不支持的导入操作");
    let pack;
    try { pack = parseNotePackage(input.package); } catch (e) { throw new LearningError(e instanceof Error ? e.message : "笔记包无效"); }
    return Response.json(await db.transaction((tx) => input.action === "preview" ? previewNoteImport(tx, id, pack) : importNotes(tx, id, pack, input.token),
      { behavior: input.action === "preview" ? "deferred" : "immediate" }));
  } catch (error) { return failure(error); }
}
