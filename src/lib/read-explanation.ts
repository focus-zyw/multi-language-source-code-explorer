import type { ChatRetryState, ExplanationEvent, ExplanationResponse } from "./ai-types.ts";

/** Decode UTF-8/JSON across arbitrary network chunks; a closed stream alone is not success. */
export async function readExplanation(response: Response, onProgress: (event: Extract<ExplanationEvent, { type: "progress" }>) => void,
  onDelta?: (text: string) => void, onRetry?: (retry: ChatRetryState) => void): Promise<ExplanationResponse> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.explanation) throw new Error(body.error ?? `生成失败（HTTP ${response.status}）`);
    return body as ExplanationResponse;
  }
  if (!response.ok || !response.body) throw new Error(`生成失败（HTTP ${response.status}）`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result: ExplanationResponse | undefined;
  const line = (text: string) => {
    if (!text.trim()) return;
    const event = JSON.parse(text) as ExplanationEvent;
    if (event.type === "progress") onProgress(event);
    else if (event.type === "delta") onDelta?.(event.text);
    else if (event.type === "retry") onRetry?.(event.retry);
    else if (event.type === "result") result = event.result;
    else if (event.type === "error") throw new Error(event.error);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) { line(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (done) break;
    }
    line(pending);
    if (!result?.explanation) throw new Error("讲解连接提前结束，未收到完整结果，请重试");
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
