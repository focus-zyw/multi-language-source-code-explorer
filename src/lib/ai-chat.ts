import { AiError } from "./ai-error.ts";

/**
 * 模型请求的传输层：SSE 流式解析 + 有限重试。
 *
 * 与 `ai.ts` 分开是为了让解析和重试能在 Node 里直接测试；本文件不读取密钥来源，
 * 也不依赖 `server-only`，调用方负责传入已校验的配置。
 *
 * 环境变量（均按次调用读取）：
 *   AI_TIMEOUT_MS       单次请求总超时，默认 120000，范围 5000–600000
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
  status: number | null;
  retryAfterMs: number | null;
  constructor(status: number | null, retryAfterMs: number | null) {
    super("retryable");
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, ms)) : null;
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
  delta?: { type?: string; text?: string };
  content_block?: { text?: string };
  choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
  content?: { type: string; text?: string }[];
};

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "")).join("");
  return "";
}

/** 返回本段增量文本；`null` 表示该事件不携带正文。 */
function deltaOf(provider: ChatConfig["provider"], payload: StreamPayload): string | null {
  if (payload.error) throw new AiError("模型服务返回了错误，请检查模型配置与额度");
  if (payload.type === "error") throw new AiError("模型服务返回了错误，请检查模型配置与额度");
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
  const dispatch = () => {
    const payload = data.join("\n");
    data = [];
    if (!payload || payload === "[DONE]") return;
    let json: StreamPayload;
    try { json = JSON.parse(payload) as StreamPayload; }
    catch { throw new AiError("模型返回了无法解析的流式响应"); }
    const chunk = deltaOf(provider, json);
    if (chunk === null) return;
    text += chunk;
    onDelta(chunk);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") { dispatch(); continue; }
        // 注释与事件名行（如 `event: content_block_delta`）不携带正文，正文类型由 data 内 JSON 判断。
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    buffer += decoder.decode();
    const tail = buffer.replace(/\r$/, "");
    if (tail.startsWith("data:")) data.push(tail.slice(5).replace(/^ /, ""));
    dispatch();
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
  touch();
  try {
    const { url, headers, body } = requestFor(cfg, system, user);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) {
      // 详细错误仅写服务端日志，且不包含请求头；返回给前端的信息不含上游原文
      const detail = await res.text().catch(() => "");
      console.error(`[ai] upstream error ${res.status}: ${detail.slice(0, 300).split(cfg.apiKey).join("***")}`);
      if (RETRYABLE_STATUS.has(res.status)) throw new RetryableFailure(res.status, retryAfterMs(res.headers.get("retry-after")));
      throw httpFailure(res.status);
    }
    touch();
    if (res.headers.get("content-type")?.includes("text/event-stream") && res.body) {
      const streamed = await readStream(res.body, cfg.provider, onDelta, touch);
      if (!streamed.trim()) throw new AiError("模型返回了空内容");
      return streamed.trim();
    }
    // 部分兼容端点或代理会忽略 stream，直接返回完整 JSON。
    const json = (await res.json()) as StreamPayload;
    const text = cfg.provider === "anthropic"
      ? (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
      : textOf(json.choices?.[0]?.message?.content);
    if (!text.trim()) throw new AiError("模型返回了空内容");
    onDelta(text);
    return text.trim();
  } catch (error) {
    if (outer?.aborted) throw new AiError("讲解已取消", 499);
    if (timedOut) throw new AiError("模型请求超时", 504);
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
        if (error.status !== null) throw httpFailure(error.status);
        throw new AiError("无法连接模型服务，请检查网络与 AI_BASE_URL");
      }
      await sleep(error.retryAfterMs ?? backoffMs(attempt), signal);
    }
  }
}
