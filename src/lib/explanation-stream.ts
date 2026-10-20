import { AiError } from "./ai-error.ts";
import type { AgentPhase, ChatRetryState, ExplanationEvent, ExplanationResponse } from "./ai-types.ts";

/** `timeoutMs` 只在本机 Agent 有单次进程上限时提供；模型 API 重试后没有单一上限。 */
export function explanationStream(signal: AbortSignal, timeoutMs: number | undefined,
  execute: (signal: AbortSignal, progress: (phase: AgentPhase) => void, delta: (text: string) => void, retry: (state: ChatRetryState) => void) => Promise<ExplanationResponse>) {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) abort.abort();
  const started = Date.now();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: ExplanationEvent) => {
        if (closed || abort.signal.aborted) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
        catch { onAbort(); }
      };
      void execute(abort.signal,
        (phase) => send({ type: "progress", phase, timeoutMs, elapsedMs: Date.now() - started }),
        (text) => send({ type: "delta", text }),
        (retry) => send({ type: "retry", retry }))
        .then((result) => send({ type: "result", result }))
        .catch((error: unknown) => send({ type: "error", error: error instanceof AiError ? error.message : "生成讲解失败，请重试" }))
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
          if (!closed) { closed = true; controller.close(); }
        });
    },
    cancel() { closed = true; onAbort(); signal.removeEventListener("abort", onAbort); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
