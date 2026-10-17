import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { symbolExplanations } from "@/db/schema";
import { AiError, EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt, completeChat, getAiConfig, getAiPublicStatus, explanationConfigKey } from "@/lib/ai";
import { completeAgent, getAgentConfig } from "@/lib/agent";
import type { AgentPhase, ExplanationBackend, ExplanationResponse } from "@/lib/ai-types";
import { explanationStream } from "@/lib/explanation-stream";
import { getSymbolForExplain, parseId } from "@/lib/queries";
import { explanationContentKey, fingerprintExplanation, storedExplanationFingerprint } from "@/lib/explanation-fingerprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 660;

// 简单的进程内限流，避免页面被刷导致模型费用失控
const hits: number[] = [];
function allow(): boolean {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) hits.shift();
  if (hits.length >= 30) return false;
  hits.push(now);
  return true;
}

const MAX_SOURCE_CHARS = 14_000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string; sid: string }> }) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "不允许跨站生成讲解" }, { status: 403 });
  if (!req.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "请求需要 application/json" }, { status: 415 });
  const p = await params;
  const id = parseId(p.id);
  const sid = parseId(p.sid);
  if (!id || !sid) return Response.json({ error: "无效的 ID" }, { status: 400 });

  const parsed: unknown = await req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "请求需要 JSON 对象" }, { status: 400 });
  }
  const body = parsed as { force?: unknown; backend?: unknown; stream?: unknown };
  const backend = body.backend ?? getAiPublicStatus().defaultBackend;
  if (backend !== "api" && backend !== "agent") return Response.json({ error: "讲解来源必须是 api 或 agent" }, { status: 400 });
  if (body.force !== undefined && typeof body.force !== "boolean") return Response.json({ error: "force 必须为布尔值" }, { status: 400 });
  if (body.stream !== undefined && typeof body.stream !== "boolean") return Response.json({ error: "stream 必须为布尔值" }, { status: 400 });
  const data = await getSymbolForExplain(id, sid);
  if (!data) return Response.json({ error: "符号不存在" }, { status: 404 });
  const { sym, file, calls, fingerprintCalls } = data;

  const configIdentity = explanationConfigKey(backend);
  const fingerprint = fingerprintExplanation({ symbol: sym, filePath: file.path, language: file.language,
    source: file.content.slice(sym.startIndex, sym.endIndex), calls: fingerprintCalls });
  const configKey = explanationContentKey(configIdentity, fingerprint);
  const [cached] = await db.select().from(symbolExplanations).where(and(eq(symbolExplanations.symbolId, sid), eq(symbolExplanations.backend, backend),
    or(eq(symbolExplanations.configKey, configKey), eq(symbolExplanations.configKey, configIdentity)))).orderBy(desc(symbolExplanations.generatedAt)).limit(1);
  if (cached && body.force !== true) {
    return Response.json({
      explanation: cached.content,
      model: cached.model,
      backend,
      generatedAt: cached.generatedAt.toISOString(),
      cached: true,
      relativeLines: storedExplanationFingerprint(cached.configKey) !== null,
    });
  }
  const apiConfig = backend === "api" ? getAiConfig() : null;
  const agentConfig = backend === "agent" ? getAgentConfig() : null;
  if (backend === "api" && !apiConfig) return Response.json({ error: "模型 API 未配置，请设置 AI_API_KEY 后重启，或选择本机 Agent" }, { status: 503 });
  if (backend === "agent" && !agentConfig) return Response.json({ error: "未找到本机 Codex，请安装 CLI 或配置 AI_AGENT_COMMAND 后重启" }, { status: 503 });
  if (!allow()) return Response.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });

  let source = file.content.slice(sym.startIndex, sym.endIndex);
  const truncated = source.length > MAX_SOURCE_CHARS;
  if (truncated) source = source.slice(0, MAX_SOURCE_CHARS);
  const m = sym.metrics;
  const structural = sym.kind === "element";
  const facts = [
    `签名：${sym.signature}`,
    structural ? `位置：${file.path}，${sym.qualifiedName}；所给源码的第一行是第 1 行。讲解中如引用行号，请明确写“片段内第 N 行”。` : `位置：${file.path}，${sym.qualifiedName}；调用行号相对于当前方法，所给源码的第一行是第 1 行。讲解中如引用行号，请明确写“方法内第 N 行”。`,
    ...(structural ? ["这是文档包含关系，不能当作函数调用或执行步骤。仅依据当前片段与文件名讲解，属性的运行时行为需说明上下文限制。"] : [`圈复杂度 ${m.complexity}，分支 ${m.branches}，循环 ${m.loops}，异常处理 ${m.handlers}，return ${m.returns}，throw/raise ${m.throws}`]),
    ...(sym.docstring ? [`文档注释：${sym.docstring.slice(0, 400)}`] : []),
  ];
  const callLines = calls.map((c) => {
    const label =
      c.resolution === "exact" ? "确定" : c.resolution === "inferred" ? "推断" : c.resolution === "heuristic" ? "猜测" : c.resolution === "external" ? "外部/内建" : "无法解析";
    return `方法内第 ${c.line - sym.startLine + 1} 行 ${c.calleeText} → ${c.target ?? "（无项目内目标）"} [${label}]`;
  });

  const execute = async (signal: AbortSignal, onProgress?: (phase: AgentPhase) => void): Promise<ExplanationResponse> => {
    const started = Date.now();
    const phases: Partial<Record<AgentPhase, number>> = {};
    let completed = false;
    try {
    const prompt = buildExplainPrompt({
        language: file.language,
        filePath: file.path,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind === "element" ? "HTML 结构节点" : sym.kind === "class" ? "类" : sym.kind === "test" ? "测试用例" : "函数/方法",
        source,
        truncated,
        facts,
        calls: callLines,
      });
    const explanation = agentConfig
      ? await completeAgent(agentConfig, EXPLAIN_SYSTEM_PROMPT, prompt, signal, (phase) => { phases[phase] = Date.now() - started; onProgress?.(phase); })
      : await completeChat(apiConfig!, EXPLAIN_SYSTEM_PROMPT, prompt, signal);
    if (signal.aborted) throw new AiError("讲解已取消", 499);
    const model = agentConfig ? `Codex · ${agentConfig.model ?? "默认模型"}` : apiConfig!.model;
    const now = new Date();
    await db.insert(symbolExplanations).values({ symbolId: sym.id, backend: backend as ExplanationBackend, configKey, content: explanation, model, generatedAt: now })
      .onConflictDoUpdate({ target: [symbolExplanations.symbolId, symbolExplanations.backend, symbolExplanations.configKey], set: { content: explanation, model, generatedAt: now } });
    const durationMs = Date.now() - started;
    completed = true;
    return { explanation, model, backend: backend as ExplanationBackend, generatedAt: now.toISOString(), cached: false, durationMs, relativeLines: true };
    } finally {
      console.info("[explain] finished", { backend, symbolId: sid, outcome: signal.aborted ? "cancelled" : completed ? "completed" : "failed", durationMs: Date.now() - started, phases });
    }
  };

  if (body.stream === true && agentConfig) return explanationStream(req.signal, agentConfig.timeoutMs, execute);
  try {
    return Response.json(await execute(req.signal));
  } catch (e) {
    if (e instanceof AiError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[explain] failed", e);
    return Response.json({ error: "生成讲解失败" }, { status: 500 });
  }
}
