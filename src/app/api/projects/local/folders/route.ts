import { listLocalFolders } from "@/lib/ingest/folders";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await readLocalBody(req);
    if (body.path !== undefined && typeof body.path !== "string") throw new ImportError("文件夹路径必须为文本");
    return Response.json(await listLocalFolders(body.path as string | undefined));
  } catch (error) {
    if (error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "无法浏览本地目录，请稍后重试" }, { status: 500 });
  }
}
