import { AiError } from "./ai-error.ts";
import type { ChatRetryState } from "./ai-types.ts";

/**
 * 模型请求的传输层：SSE 流式解析 + 有限重试。
 *
 * 与 `ai.ts` 分开是为了让解析和重试能在 Node 里直接测试；本文件不读取密钥来源，
 * 也不依赖 `server-only`，调用方负责传入已校验的配置。
 *
 * 环境变量（均按次调用读取）：
 *   AI_TIMEOUT_MS       等待响应头 / 非流式请求总超时，默认 120000，范围 5000–600000
 *   AI_IDLE_TIMEOUT_MS  两个数据块之间的最长等待，默认 60000，范围 1000–300000
 *   AI_RETRY_ATTEMPTS   总尝试次数，默认 3，范围 1–5
 */

export interface ChatConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatOptions {
  /** 收到增量文本时调用；一旦调用过就不再重试，避免重复内容。 */
  onDelta?: (chunk: string) => void;
  onRetry?: (state: ChatRetryState) => void;
  /** 覆盖 `AI_RETRY_ATTEMPTS`，主要用于测试。 */
  maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 8_000;
/** 可重试的上游状态：限流、超时与 5xx；其余 4xx 属于配置或请求错误，重试无意义。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 内部信号：交给重试循环决定是否再试一次，永不直接暴露给调用方。 */
class RetryableFailure extends Error {
  // 参数属性写法不被 Node 的类型剥离支持，这里显式声明字段。
  retryDeadline: number | null;
  reason: ChatRetryState["reason"];
  failure: AiError;
  constructor(status: number | null, retryDeadline: number | null, failure?: AiError) {
    super("retryable");
    this.retryDeadline = retryDeadline;
    this.reason = status === 429 ? "rate-limit" : status !== null ? "server" : failure?.status === 504 ? "timeout" : "network";
    this.failure = failure ?? (status !== null ? httpFailure(status) : new AiError("无法连接模型服务，请检查网络与 AI_BASE_URL"));
  }
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

function retryDeadline(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
  // 服务端要求的等待时间独立于本地退避上限；从收到响应头时开始计时。
  return Number.isFinite(ms) ? performance.now() + Math.max(0, ms) : null;
}

async function waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
  while (deadline > performance.now()) {
    await sleep(Math.min(deadline - performance.now(), 2_147_483_647), signal);
  }
  if (signal?.aborted) throw new AiError("讲解已取消", 499);
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)) + Math.random() * 200;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AiError("讲解已取消", 499)); return; }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => { clearTimeout(timer); reject(new AiError("讲解已取消", 499)); };
    timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requestFor(cfg: ChatConfig, system: string, user: string): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (cfg.provider === "anthropic") {
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: { model: cfg.model, max_tokens: 1600, stream: true, system, messages: [{ role: "user", content: user }] },
    };
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: {
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 1600,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  };
}

type StreamPayload = {
  error?: { message?: string };
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  content_block?: { text?: string };
  choices?: { delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: string | null }[];
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
};

/** 完成标记只代表传输结束，显式的截断/拒绝/工具请求不能作为完整讲解保存。 */
function assertCompleteReason(provider: ChatConfig["provider"], payload: StreamPayload) {
  const reason = provider === "anthropic" ? payload.stop_reason ?? payload.delta?.stop_reason : payload.choices?.[0]?.finish_reason;
  // 保留不提供结束原因的兼容端点；只校验上游明确给出的原因。
  if (reason == null) return;
  const successful = provider === "anthropic" ? ["end_turn", "stop_sequence"] : ["stop"];
  if (successful.includes(reason)) return;
  if (["length", "max_tokens", "model_context_window_exceeded"].includes(reason)) {
    throw new AiError("模型输出达到长度上限，讲解未完整生成，请重试或调整模型配置", 502);
  }
  throw new AiError("模型未正常完成讲解，请重试或调整模型配置", 502);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "")).join("");
  return "";
}

/** 返回本段增量文本；`null` 表示该事件不携带正文。 */
function deltaOf(provider: ChatConfig["provider"], payload: StreamPayload): string | null {
  if (payload.error) throw new AiError("模型服务返回了错误，请检查模型配置与额度");
  if (payload.type === "error") throw new AiError("模型服务返回了错误，请检查模型配置与额度");
  assertCompleteReason(provider, payload);
  if (provider === "anthropic") {
    if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") return payload.delta.text ?? "";
    if (payload.type === "content_block_start") return payload.content_block?.text || null;
    return null;
  }
  const choice = payload.choices?.[0];
  return textOf(choice?.delta?.content) || textOf(choice?.message?.content) || null;
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  provider: ChatConfig["provider"],
  onDelta: (chunk: string) => void,
  touch: () => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let text = "";
  let completed = false;
  const dispatch = () => {
    const payload = data.join("\n");
    data = [];
    if (!payload) return;
    if (provider === "openai" && payload === "[DONE]") { completed = true; return; }
    let json: StreamPayload;
    try { json = JSON.parse(payload) as StreamPayload; }
    catch { throw new AiError("模型返回了无法解析的流式响应"); }
    const chunk = deltaOf(provider, json);
    if (provider === "anthropic" && json.type === "message_stop") { completed = true; return; }
    if (chunk === null) return;
    text += chunk;
    onDelta(chunk);
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while (!completed && (index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") { dispatch(); continue; }
        // 注释与事件名行（如 `event: content_block_delta`）不携带正文，正文类型由 data 内 JSON 判断。
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (!completed) {
      buffer += decoder.decode();
      const tail = buffer.replace(/\r$/, "");
      if (tail.startsWith("data:")) data.push(tail.slice(5).replace(/^ /, ""));
      dispatch();
    }
    if (!completed) throw new AiError("模型响应提前结束，未收到完整讲解，请重试", 502);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text;
}

function httpFailure(status: number): AiError {
  if (status === 401 || status === 403) return new AiError(`模型服务拒绝了请求（HTTP ${status}），请检查服务端的 AI_API_KEY / AI_BASE_URL / AI_MODEL 配置`);
  if (status === 429) return new AiError("模型服务限流（HTTP 429），重试后仍未成功，请稍后再试");
  return new AiError(`模型服务返回错误（HTTP ${status}），请检查服务端的 AI_API_KEY / AI_BASE_URL / AI_MODEL 配置`);
}

async function attemptChat(cfg: ChatConfig, system: string, user: string, outer: AbortSignal | undefined, onDelta: (chunk: string) => void): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const overallMs = numberFromEnv("AI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 5_000, 600_000);
  const idleMs = numberFromEnv("AI_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS, 1_000, 300_000);
  const overall = setTimeout(() => { timedOut = true; controller.abort(); }, overallMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  // 流式请求的总时长无法预估，因此用「两块数据之间的间隔」判断卡死。
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { timedOut = true; controller.abort(); }, idleMs);
  };
  try {
    const { url, headers, body } = requestFor(cfg, system, user);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) {
      const advisedDeadline = retryDeadline(res.headers.get("retry-after"));
      // 详细错误仅写服务端日志，且不包含请求头；返回给前端的信息不含上游原文
      const detail = await res.text().catch(() => "");
      console.error(`[ai] upstream error ${res.status}: ${detail.slice(0, 300).split(cfg.apiKey).join("***")}`);
      if (RETRYABLE_STATUS.has(res.status)) throw new RetryableFailure(res.status, advisedDeadline);
      throw httpFailure(res.status);
    }
    if (res.headers.get("content-type")?.includes("text/event-stream") && res.body) {
      clearTimeout(overall);
      touch();
      const streamed = await readStream(res.body, cfg.provider, onDelta, touch);
      if (!streamed.trim()) throw new AiError("模型返回了空内容");
      return streamed.trim();
    }
    // 部分兼容端点或代理会忽略 stream，直接返回完整 JSON。
    const json = (await res.json()) as StreamPayload;
    assertCompleteReason(cfg.provider, json);
    const text = cfg.provider === "anthropic"
      ? (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
      : textOf(json.choices?.[0]?.message?.content);
    if (!text.trim()) throw new AiError("模型返回了空内容");
    onDelta(text);
    return text.trim();
  } catch (error) {
    if (outer?.aborted) throw new AiError("讲解已取消", 499);
    if (timedOut) throw new RetryableFailure(null, null, new AiError("模型请求超时", 504));
    if (error instanceof AiError || error instanceof RetryableFailure) throw error;
    console.error("[ai] request failed:", error instanceof Error ? error.message.split(cfg.apiKey).join("***") : "unknown");
    // undici 把连接失败与流中断都表现为 TypeError；其余异常来自调用方回调，不应被当作网络问题重试。
    if (error instanceof TypeError) throw new RetryableFailure(null, null);
    throw new AiError("模型请求失败，请稍后重试");
  } finally {
    clearTimeout(overall);
    if (idle) clearTimeout(idle);
    outer?.removeEventListener("abort", onAbort);
  }
}

export async function completeChat(cfg: ChatConfig, system: string, user: string, signal?: AbortSignal, options: ChatOptions = {}): Promise<string> {
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, options.maxAttempts ?? numberFromEnv("AI_RETRY_ATTEMPTS", DEFAULT_ATTEMPTS, 1, MAX_ATTEMPTS)));
  let emitted = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptChat(cfg, system, user, signal, (chunk) => { emitted = true; options.onDelta?.(chunk); });
    } catch (error) {
      // 已经输出过正文就不能重试，否则用户会看到重复内容。
      if (!(error instanceof RetryableFailure)) throw error;
      if (emitted || signal?.aborted || attempt >= attempts) {
        throw error.failure;
      }
      const deadline = error.retryDeadline ?? performance.now() + backoffMs(attempt);
      const retry = { attempt: attempt + 1, maxAttempts: attempts, reason: error.reason };
      options.onRetry?.({ ...retry, retryAt: Date.now() + Math.max(0, deadline - performance.now()) });
      await waitUntil(deadline, signal);
      options.onRetry?.({ ...retry, retryAt: null });
    }
  }
}
