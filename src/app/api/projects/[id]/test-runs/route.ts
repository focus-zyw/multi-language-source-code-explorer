import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { files, symbols } from "@/db/schema";
import { getProject, parseId } from "@/lib/queries";
import { checkLocalRequest, readLocalBody } from "@/lib/ingest/local-request";
import { ImportError } from "@/lib/ingest/rules";
import { cancelRun, discoverRunners, hashSource, latestRun, projectRoot, safeFile, startRun, type TraceTarget } from "@/lib/test-runner";
import type { TestRunState } from "@/lib/test-run-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function context(req: Request, params: Promise<{ id: string }>) {
  checkLocalRequest(req);
  const id = parseId((await params).id);
  if (!id) throw new ImportError("无效的项目 ID");
  const project = await getProject(id);
  if (!project) throw new ImportError("项目不存在", 404);
  if (project.sourceType !== "local" || !project.sourcePath) throw new ImportError("仅本地目录项目支持测试执行；上传项目仍只做静态分析", 409);
  return { id, project };
}

function failure(error: unknown) {
  return Response.json({ error: error instanceof ImportError ? error.message : "测试服务暂不可用，请检查本机项目环境" }, { status: error instanceof ImportError ? error.status : 500 });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id, project } = await context(req, params);
    if (process.env.CODE_ATLAS_TEST_EXECUTION !== "true") return Response.json({ enabled: false, reason: "测试执行默认关闭。在应用的 .env.local 中设置 CODE_ATLAS_TEST_EXECUTION=true 并重启后可启用。", profiles: [], run: null } satisfies TestRunState);
    const root = await projectRoot(project.sourcePath!);
    const profiles = (await discoverRunners(root)).map(({ id, label, command, coverage, kind }) => ({ id, label, command, coverage, kind }));
    const run = latestRun(id);
    // Return coverage only for the requested symbol's file, after checking ownership and both source copies.
    const sid = parseId(new URL(req.url).searchParams.get("symbolId") ?? "");
    let coverage = run?.coverage ?? [];
    let trace = run?.trace;
    let traceNote = run?.traceNote;
    if (sid) {
      const [row] = await db.select({ path: files.path, content: files.content, startLine: symbols.startLine, endLine: symbols.endLine }).from(symbols).innerJoin(files, eq(symbols.fileId, files.id)).where(and(eq(symbols.id, sid), eq(symbols.projectId, id)));
      if (!row) throw new ImportError("方法不属于该项目或已重新扫描", 404);
      let liveHash = "";
      try { liveHash = hashSource(await safeFile(root, row.path)); } catch { /* Do not map unavailable files. */ }
      coverage = coverage.filter((file) => file.path === row.path && file.sourceHash === hashSource(row.content) && file.sourceHash === liveHash);
      if (trace && (trace.target.file !== row.path || trace.target.startLine !== row.startLine || trace.target.endLine !== row.endLine || trace.target.sourceHash !== hashSource(row.content) || trace.target.sourceHash !== liveHash)) {
        trace = undefined;
        traceNote = "调用记录不属于当前源码版本或文件，已隐藏；请在当前方法重新运行。";
      }
    } else { coverage = []; trace = undefined; }
    return Response.json({ enabled: true, profiles, reason: profiles.length ? "" : "未发现可直接运行的测试配置。支持简单的 package.json test/test:* 脚本（node --test、vitest、jest），以及含配置文件的 pytest。不会执行 shell 组合脚本或安装依赖。", run: run ? { ...run, coverage, trace, traceNote } : null } satisfies TestRunState);
  } catch (error) { return failure(error); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await readLocalBody(req);
    const { id, project } = await context(req, params);
    if (process.env.CODE_ATLAS_TEST_EXECUTION !== "true") throw new ImportError("本机尚未启用测试执行", 403);
    if (body.action === "stop" && typeof body.runId === "string") { cancelRun(id, body.runId); return Response.json({ ok: true }); }
    if (body.action !== "run" || body.confirmExecution !== true || typeof body.coverage !== "boolean") throw new ImportError("请明确确认执行本地项目代码");
    if (body.trace !== undefined && typeof body.trace !== "boolean") throw new ImportError("trace 必须为布尔值");
    const root = await projectRoot(project.sourcePath!);
    const profile = (await discoverRunners(root)).find((p) => p.id === body.profileId);
    if (!profile || profile.command !== body.command) throw new ImportError("测试配置发生变化，请刷新配置后重试", 409);
    let trace: TraceTarget | undefined;
    if (body.trace === true) {
      const sid = parseId(String(body.symbolId ?? ""));
      if (!sid) throw new ImportError("追踪需要指定一个方法");
      const [row] = await db.select({ name: symbols.name, kind: symbols.kind, startLine: symbols.startLine, endLine: symbols.endLine, path: files.path, language: files.language, content: files.content })
        .from(symbols).innerJoin(files, eq(symbols.fileId, files.id))
        .where(and(eq(symbols.id, sid), eq(symbols.projectId, id)));
      if (!row) throw new ImportError("方法不属于该项目或已重新扫描", 404);
      if (row.language !== "python") throw new ImportError("调用追踪目前只支持 Python 方法", 400);
      if (!["function", "method", "test"].includes(row.kind)) throw new ImportError("请选择一个有函数体的方法进行追踪", 400);
      trace = { file: row.path, func: row.name, startLine: row.startLine, endLine: row.endLine, sourceHash: hashSource(row.content) };
    }
    const sources = body.coverage ? await db.select({ path: files.path, content: files.content }).from(files).where(eq(files.projectId, id)) : [];
    const result = await startRun(id, root, profile, body.coverage, sources, undefined, trace);
    return Response.json({ id: result.id }, { status: 202 });
  } catch (error) { return failure(error); }
}
