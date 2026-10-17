import { getAnalysis, parseId } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const p = await params;
  const id = parseId(p.id);
  const sid = parseId(p.sid);
  if (!id || !sid) return Response.json({ error: "无效的 ID" }, { status: 400 });
  try {
    const result = await getAnalysis(id, sid);
    if (!result) return Response.json({ error: "符号不存在" }, { status: 404 });
    return Response.json(result);
  } catch (e) {
    console.error("[analysis] failed", e);
    return Response.json({ error: "分析失败" }, { status: 500 });
  }
}
