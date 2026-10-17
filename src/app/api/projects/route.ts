import { listProjects } from "@/lib/queries";
import { ImportError, LIMITS } from "@/lib/ingest/rules";
import { collectFromUploads, collectFromZip, type CollectResult, type UploadItem } from "@/lib/ingest/zip";
import { ingestProject } from "@/lib/ingest/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return Response.json({ projects: await listProjects() });
}

function cleanClientSkipped(raw: FormDataEntryValue | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "string") return out;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (/^[a-z-]{1,30}$/.test(k) && typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e7) out[k] = Math.floor(v);
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > LIMITS.maxUploadBytes) throw new ImportError("上传内容超过大小上限", 413);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ImportError("无法解析上传内容（需要 multipart/form-data）");
    }
    const mode = form.get("mode");
    const nameRaw = String(form.get("name") ?? "").trim();
    let collected: CollectResult;
    let name = nameRaw;

    if (mode === "zip") {
      const file = form.get("file");
      if (!(file instanceof File)) throw new ImportError("缺少 ZIP 文件");
      if (file.size > LIMITS.maxZipBytes) throw new ImportError("ZIP 文件超过大小上限（100MB）", 413);
      collected = await collectFromZip(Buffer.from(await file.arrayBuffer()));
      name = name || file.name.replace(/\.zip$/i, "") || collected.rootName || "zip-project";
    } else if (mode === "folder") {
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      let paths: unknown;
      try {
        paths = JSON.parse(String(form.get("paths") ?? "[]"));
      } catch {
        throw new ImportError("paths 字段不是合法 JSON");
      }
      if (!Array.isArray(paths) || paths.length !== files.length || paths.some((p) => typeof p !== "string")) {
        throw new ImportError("文件与路径数量不一致");
      }
      if (files.length > 20_000) throw new ImportError("单次上传的文件数过多");
      const items: UploadItem[] = files.map((f, i) => ({
        rawPath: paths[i] as string,
        size: f.size,
        read: async () => Buffer.from(await f.arrayBuffer()),
      }));
      collected = await collectFromUploads(items);
      name = name || collected.rootName || "folder-project";
    } else {
      throw new ImportError("mode 必须是 zip 或 folder");
    }

    if (!collected.files.length) {
      throw new ImportError("没有找到可分析的源码文件（当前支持 Python / JavaScript / TypeScript；node_modules、.git 等目录会被忽略）", 422);
    }
    const result = await ingestProject({
      name,
      sourceType: mode,
      files: collected.files,
      skipped: collected.skipped,
      warnings: collected.warnings,
      clientSkipped: cleanClientSkipped(form.get("clientSkipped")),
    });
    return Response.json({ id: result.projectId, fileCount: result.fileCount, symbolCount: result.symbolCount, stats: result.stats }, { status: 201 });
  } catch (e) {
    if (e instanceof ImportError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[import] failed", e);
    return Response.json({ error: "导入失败：服务器内部错误" }, { status: 500 });
  }
}
