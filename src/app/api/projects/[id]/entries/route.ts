import { getProjectEntries } from "@/lib/project-entries-query";
import { parseId } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "无效的项目 ID" }, { status: 400 });
  const entries = await getProjectEntries(id);
  if (!entries) return Response.json({ error: "项目不存在" }, { status: 404 });
  return Response.json(entries);
}
