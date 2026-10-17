import { getCallTreePage } from "@/lib/call-tree-query";
import { parseId } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const paramsValue = await params;
  const id = parseId(paramsValue.id);
  const sid = parseId(paramsValue.sid);
  if (!id || !sid) return Response.json({ error: "无效的项目或方法 ID" }, { status: 400 });
  const query = new URL(req.url).searchParams;
  const direction = query.get("direction") ?? "outgoing";
  const offset = query.get("offset") ?? "0";
  const scope = query.get("scope") ?? "all";
  if (scope !== "all" && scope !== "project") return Response.json({ error: "无效的调用范围" }, { status: 400 });
  if (direction !== "outgoing" && direction !== "incoming") return Response.json({ error: "无效的探索方向" }, { status: 400 });
  if (!/^\d{1,7}$/.test(offset)) return Response.json({ error: "无效的分页位置" }, { status: 400 });
  const page = await getCallTreePage(id, sid, direction, Number(offset), scope === "all");
  if (!page) return Response.json({ error: "方法不存在或已重新扫描，请刷新项目" }, { status: 404 });
  return Response.json(page);
}
