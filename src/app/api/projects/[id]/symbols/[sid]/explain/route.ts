import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { symbolExplanations } from "@/db/schema";
import { AiError, EXPLAIN_SYSTEM_PROMPT, buildExplainPrompt, completeChat, getAiConfig, getAiPublicStatus, explanationConfigKey } from "@/lib/ai";
import { completeAgent, getAgentConfig } from "@/lib/agent";
import type { ExplanationBackend } from "@/lib/ai-types";
import { getSymbolForExplain, parseId } from "@/lib/queries";

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
  const body = parsed as { force?: unknown; backend?: unknown };
  const backend = body.backend ?? getAiPublicStatus().defaultBackend;
  if (backend !== "api" && backend !== "agent") return Response.json({ error: "讲解来源必须是 api 或 agent" }, { status: 400 });
  if (body.force !== undefined && typeof body.force !== "boolean") return Response.json({ error: "force 必须为布尔值" }, { status: 400 });
  const data = await getSymbolForExplain(id, sid);
  if (!data) return Response.json({ error: "符号不存在" }, { status: 404 });
  const { sym, file, calls } = data;

  const configKey = explanationConfigKey(backend);
  const [cached] = await db.select().from(symbolExplanations).where(and(eq(symbolExplanations.symbolId, sid), eq(symbolExplanations.backend, backend), eq(symbolExplanations.configKey, configKey))).limit(1);
  if (cached && body.force !== true) {
    return Response.json({
      explanation: cached.content,
      model: cached.model,
      backend,
      generatedAt: cached.generatedAt.toISOString(),
      cached: true,
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
  const facts = [
    `签名：${sym.signature}`,
    `位置：${file.path} 第 ${sym.startLine}–${sym.endLine} 行`,
    `圈复杂度 ${m.complexity}，分支 ${m.branches}，循环 ${m.loops}，异常处理 ${m.handlers}，return ${m.returns}，throw/raise ${m.throws}`,
    ...(sym.docstring ? [`文档注释：${sym.docstring.slice(0, 400)}`] : []),
  ];
  const callLines = calls.map((c) => {
    const label =
      c.resolution === "exact" ? "确定" : c.resolution === "inferred" ? "推断" : c.resolution === "heuristic" ? "猜测" : c.resolution === "external" ? "外部/内建" : "无法解析";
    return `第 ${c.line} 行 ${c.calleeText} → ${c.target ?? "（无项目内目标）"} [${label}]`;
  });

  try {
    const prompt = buildExplainPrompt({
        language: file.language,
        filePath: file.path,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind === "class" ? "类" : sym.kind === "test" ? "测试用例" : "函数/方法",
        source,
        truncated,
        facts,
        calls: callLines,
      });
    const explanation = agentConfig
      ? await completeAgent(agentConfig, EXPLAIN_SYSTEM_PROMPT, prompt, req.signal)
      : await completeChat(apiConfig!, EXPLAIN_SYSTEM_PROMPT, prompt);
    const model = agentConfig ? `Codex · ${agentConfig.model ?? "默认模型"}` : apiConfig!.model;
    const now = new Date();
    await db.insert(symbolExplanations).values({ symbolId: sym.id, backend: backend as ExplanationBackend, configKey, content: explanation, model, generatedAt: now })
      .onConflictDoUpdate({ target: [symbolExplanations.symbolId, symbolExplanations.backend, symbolExplanations.configKey], set: { content: explanation, model, generatedAt: now } });
    return Response.json({ explanation, model, backend, generatedAt: now.toISOString(), cached: false });
  } catch (e) {
    if (e instanceof AiError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[explain] failed", e);
    return Response.json({ error: "生成讲解失败" }, { status: 500 });
  }
}
