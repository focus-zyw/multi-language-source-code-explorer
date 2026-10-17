import { collectLocalDirectory } from "@/lib/ingest/local";
import { readLocalBody } from "@/lib/ingest/local-request";
import { ingestProject } from "@/lib/ingest/pipeline";
import { ImportError } from "@/lib/ingest/rules";
import { getProject, parseId } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const running = new Set<number>();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let lockedId: number | undefined;
  try {
    await readLocalBody(req);
    const id = parseId((await params).id);
    if (!id) throw new ImportError("无效的项目 ID");
    if (running.has(id)) throw new ImportError("该项目正在重新扫描，请稍后再试", 409);
    running.add(id);
    lockedId = id;
    const project = await getProject(id);
    if (!project) throw new ImportError("项目不存在", 404);
    if (project.sourceType !== "local" || !project.sourcePath) throw new ImportError("仅本地路径导入的项目支持重新扫描", 409);
    const collected = await collectLocalDirectory(project.sourcePath);
    const result = await ingestProject({ name: project.name, sourceType: "local", sourcePath: collected.sourcePath,
      replaceProjectId: id, files: collected.files, skipped: collected.skipped, warnings: collected.warnings });
    return Response.json({ id: result.projectId, fileCount: result.fileCount, symbolCount: result.symbolCount, stats: result.stats, preservedExplanations: result.preservedExplanations });
  } catch (error) {
    if (error instanceof ImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[rescan] failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "重新扫描失败，已保留原有分析，请稍后重试" }, { status: 500 });
  } finally {
    if (lockedId !== undefined) running.delete(lockedId);
  }
}
