import { sql } from "drizzle-orm";
import { db } from "@/db";
import { parseId } from "@/lib/queries";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";
import { ensureLearningTables, scanRevision, captureAnchor, listBookmarks, addBookmark, resolveAnchor, LearningError } from "@/lib/learning-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function errorResponse(error: unknown) {
  if (error instanceof LearningError || error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
  console.error("[learning] request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "学习记录操作失败，请重试" }, { status: 500 });
}
async function projectId(context: Context) {
  const id = parseId((await context.params).id);
  if (!id) throw new LearningError("无效的项目 ID");
  await ensureLearningTables(db);
  return id;
}
export async function GET(request: Request, context: Context) {
  try {
    const id = await projectId(context), query = new URL(request.url).searchParams;
    const symbol = query.get("symbolId"), root = query.get("rootId");
    if (symbol !== null && !parseId(symbol) || root !== null && !parseId(root)) throw new LearningError("无效的节点 ID");
    const result = await db.transaction(async (tx) => ({
      revision: await scanRevision(tx, id),
      selected: symbol ? await captureAnchor(tx, id, Number(symbol)) : null,
      root: root ? await captureAnchor(tx, id, Number(root)) : null,
      bookmarks: query.get("list") === "1" ? await listBookmarks(tx, id) : [],
    }), { behavior: "deferred" });
    return Response.json(result);
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const body = await readLocalBody(request), id = await projectId(context);
    const result = await db.transaction(async (tx) => {
      const revision = await scanRevision(tx, id);
      if (body.action === "bookmark") {
        if (!Number.isSafeInteger(body.symbolId) || Number(body.symbolId) < 1) throw new LearningError("无效的节点 ID");
        return { revision, id: await addBookmark(tx, id, Number(body.symbolId), body.revision) };
      }
      if (body.action === "remove") {
        if (typeof body.bookmarkId !== "string" || body.bookmarkId.length > 100) throw new LearningError("无效的书签 ID");
        await tx.run(sql`delete from learning_bookmarks where project_id = ${id} and id = ${body.bookmarkId}`);
        return { revision };
      }
      if (body.action === "resolve") {
        if (!Array.isArray(body.anchors) || body.anchors.length > 2) throw new LearningError("最多同时恢复两个阅读位置");
        const anchors = [];
        for (const anchor of body.anchors) anchors.push(await resolveAnchor(tx, id, anchor));
        return { revision, anchors };
      }
      throw new LearningError("不支持的学习记录操作");
    }, { behavior: body.action === "resolve" ? "deferred" : "immediate" });
    return Response.json(result);
  } catch (error) { return errorResponse(error); }
}
