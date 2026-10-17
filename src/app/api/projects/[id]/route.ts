import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getProject, parseId } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "无效的项目 ID" }, { status: 400 });
  const project = await getProject(id);
  if (!project) return Response.json({ error: "项目不存在" }, { status: 404 });
  return Response.json({ project });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "无效的项目 ID" }, { status: 400 });
  await db.delete(projects).where(eq(projects.id, id));
  return Response.json({ ok: true });
}
