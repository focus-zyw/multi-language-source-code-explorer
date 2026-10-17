import { getSymbolDetail, parseId } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const p = await params;
  const id = parseId(p.id);
  const sid = parseId(p.sid);
  if (!id || !sid) return Response.json({ error: "无效的 ID" }, { status: 400 });
  const detail = await getSymbolDetail(id, sid);
  if (!detail) return Response.json({ error: "符号不存在" }, { status: 404 });
  return Response.json(detail);
}
