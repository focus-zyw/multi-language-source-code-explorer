import { collectLocalDirectory } from "@/lib/ingest/local";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ingestProject } from "@/lib/ingest/pipeline";
import { ImportError } from "@/lib/ingest/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = await readLocalBody(req);
    if (typeof body.path !== "string" || !body.path.trim()) throw new ImportError("请输入本地源码目录的绝对路径");
    if (body.action !== "preview" && body.action !== "import") throw new ImportError("action 必须是 preview 或 import");
    if (body.name !== undefined && typeof body.name !== "string") throw new ImportError("项目名称必须为文本");
    const collected = await collectLocalDirectory(body.path, body.action === "preview");
    if (body.action === "preview") {
      const skipped: Record<string, number> = {};
      for (const item of collected.skipped) skipped[item.reason] = (skipped[item.reason] ?? 0) + 1;
      return Response.json({ sourcePath: collected.sourcePath, name: collected.rootName, fileCount: collected.fileCount,
        totalBytes: collected.totalBytes, samplePaths: collected.samplePaths, skipped });
    }
    if (!collected.fileCount) throw new ImportError("没有找到可分析的源码文件，请选择包含 Python / JavaScript / TypeScript 的项目目录", 422);
    const result = await ingestProject({ name: typeof body.name === "string" ? body.name.trim() || collected.rootName : collected.rootName,
      sourceType: "local", sourcePath: collected.sourcePath, files: collected.files, skipped: collected.skipped, warnings: collected.warnings });
    return Response.json({ id: result.projectId, fileCount: result.fileCount, symbolCount: result.symbolCount, stats: result.stats }, { status: 201 });
  } catch (error) {
    if (error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[local-import] failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "本地导入失败，请稍后重试" }, { status: 500 });
  }
}
