import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { symbolQuestions } from "@/db/schema";
import { AiError, completeChat, getAiConfig, getAiPublicStatus } from "@/lib/ai";
import { completeAgent, getAgentConfig } from "@/lib/agent";
import { getSymbolDetail, parseId } from "@/lib/queries";
import { questionHistory, questionOwner, questionSource } from "@/lib/questions-server";
import { buildQuestionContext } from "@/lib/question-context";
import { buildQuestionPrompt, QUESTION_SYSTEM } from "@/lib/question-prompt";
import { parseQuestionInput } from "@/lib/question-types";
import { explanationStream } from "@/lib/explanation-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 660;
type Context = { params: Promise<{ id: string; sid: string }> };
const active = new Set<string>();
const hits: number[] = [];

export async function GET(req: Request, { params }: Context) {
  const p = await params;
  const id = parseId(p.id), sid = parseId(p.sid);
  if (!id || !sid) return Response.json({ error: "无效 ID" }, { status: 400 });
  const backend = new URL(req.url).searchParams.get("backend") ?? getAiPublicStatus().defaultBackend;
  if (backend !== "api" && backend !== "agent") return Response.json({ error: "无效来源" }, { status: 400 });
  const owner = await questionOwner(id, sid);
  if (!owner) return Response.json({ error: "方法不存在，请重新选择" }, { status: 404 });
  return Response.json(await questionHistory(id, owner, backend));
}

export async function POST(req: Request, { params }: Context) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "不允许跨站提问" }, { status: 403 });
  if (!req.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "需要 JSON 请求" }, { status: 415 });
  // Bound even chunked requests before parsing JSON.
  const reader = req.body?.getReader();
  if (!reader) return Response.json({ error: "请求为空" }, { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 48000) { await reader.cancel(); return Response.json({ error: "提问内容过长" }, { status: 413 }); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { raw = null; }
  const input = parseQuestionInput(raw);
  if (!input) return Response.json({ error: "问题、引用或来源无效（问题最多 4000 字，引用最多 6000 字）" }, { status: 400 });
  const p = await params, id = parseId(p.id), sid = parseId(p.sid);
  if (!id || !sid) return Response.json({ error: "无效 ID" }, { status: 400 });
  const owner = await questionOwner(id, sid);
  if (!owner) return Response.json({ error: "方法不存在，请重新选择" }, { status: 404 });
  if (input.fingerprint !== owner.fingerprint) return Response.json({ error: "源码上下文已变化，请刷新问答后重试" }, { status: 409 });
  const key = `${id}:${owner.identity}:${input.backend}`;
  if (active.has(key)) return Response.json({ error: "此方法已有问答正在生成" }, { status: 409 });
  const api = input.backend === "api" ? getAiConfig() : null, agent = input.backend === "agent" ? getAgentConfig() : null;
  if (!api && !agent) return Response.json({ error: "当前问答来源未配置，请切换来源" }, { status: 503 });
  const now = Date.now(); while (hits.length && hits[0] < now - 60000) hits.shift();
  if (hits.length >= 20) return Response.json({ error: "提问过于频繁，请稍后重试" }, { status: 429 });
  hits.push(now); active.add(key);
  let streamStarted = false;
  try {
    const history = await questionHistory(id, owner, input.backend);
    const duplicate = await db.select().from(symbolQuestions).where(and(eq(symbolQuestions.projectId, id), eq(symbolQuestions.requestId, input.requestId))).limit(1);
    if (duplicate.length) return Response.json({ error: "该提问已提交，请刷新历史查看结果" }, { status: 409 });
    const sources = [questionSource(owner, "0")];
    // Only explicitly requested, project-owned symbols can supplement the context.
    for (const relatedId of input.relatedIds ?? []) {
      if (relatedId === sid) continue;
      const related = await questionOwner(id, relatedId);
      if (!related) return Response.json({ error: "补充方法不属于当前项目或已失效" }, { status: 400 });
      sources.push(questionSource(related, String(sources.length)));
    }
    const detail = await getSymbolDetail(id, sid);
    if (!detail) return Response.json({ error: "方法已失效" }, { status: 409 });
    // Keep source/facts bounded separately. The full source is supplied in sources.
    const saved = detail.ai.explanations[input.backend];
    const context = buildQuestionContext({ ...detail, outgoing: detail.outgoing.slice(0, 30) }, input.backend, saved ? { ...saved, explanation: saved.explanation.slice(0, 6000) } : null, false, false).slice(0, 16000) + "\n上下文限额：静态调用最多30项，已有讲解最多6000字，事实最多16000字；未提供的内容不能假定已读取。";
    let previousSize = 0;
    const previous = history.turns.filter((turn) => turn.status === "completed" && !turn.outdated && turn.sources.every((source, i) => sources[i]?.meta.path === source.path && sources[i]?.meta.name === source.name && sources[i]?.meta.hash === source.hash)).slice(-8).reverse().filter((turn) => {
      previousSize += turn.question.length + (turn.answer?.length ?? 0) + (turn.quote?.text.length ?? 0); return previousSize <= 18000;
    }).reverse();
    const prompt = buildQuestionPrompt(context, sources, previous, input.question, input.quote ?? null);
    const [row] = await db.insert(symbolQuestions).values({ projectId: id, identity: owner.identity, backend: input.backend, requestId: input.requestId, fingerprint: owner.fingerprint, question: input.question, quote: input.quote ?? null, sources: sources.map((source) => source.meta), status: "pending", createdAt: new Date() }).returning();
    const execute = async (signal: AbortSignal, progress: (phase: import("@/lib/ai-types").AgentPhase) => void) => {
      try {
        progress("starting");
        if (!agent) progress("running");
        const answer = agent ? await completeAgent(agent, QUESTION_SYSTEM, prompt, signal, progress) : await completeChat(api!, QUESTION_SYSTEM, prompt, signal);
        if (signal.aborted) throw new AiError("问答已停止", 499);
        // A concurrent rescan is allowed; the saved fingerprint marks this answer's original context.
        const model = agent ? `Codex · ${agent.model ?? "默认模型"}` : api!.model;
        await db.update(symbolQuestions).set({ answer, status: "completed", model }).where(eq(symbolQuestions.id, row.id));
        return { explanation: answer, model, generatedAt: row.createdAt.toISOString(), backend: input.backend, cached: false, relativeLines: true };
      } catch (error) {
        await db.update(symbolQuestions).set({ status: signal.aborted ? "cancelled" : "failed" }).where(eq(symbolQuestions.id, row.id));
        throw error;
      } finally { active.delete(key); }
    };
    // Release the preflight lock only after the returned stream finishes.
    streamStarted = true;
    const response = explanationStream(req.signal, agent?.timeoutMs ?? 90000, execute);
    return response;
  } catch (error) {
    active.delete(key);
    console.error("[questions] request failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "问答保存或启动失败，请重试" }, { status: 500 });
  } finally {
    // Preflight early returns have no live request holding this identity.
    if (!streamStarted) active.delete(key);
  }
}
