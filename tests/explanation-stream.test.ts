import assert from "node:assert/strict";
import { test } from "node:test";
import { explanationStream } from "../src/lib/explanation-stream.ts";
import { readExplanation } from "../src/lib/read-explanation.ts";
import { AiError } from "../src/lib/ai-error.ts";
import type { ChatRetryState, ExplanationResponse } from "../src/lib/ai-types.ts";

const result: ExplanationResponse = { explanation: "中文讲解", model: "fixture", generatedAt: null, backend: "agent", cached: false, durationMs: 123 };

test("explanation stream sends lifecycle progress and final result, preserving UTF-8 across chunks", async () => {
  const phases: string[] = [];
  const stream = explanationStream(new AbortController().signal, 5000, async (_signal, progress) => {
    progress("starting"); progress("running"); return result;
  });
  assert.deepEqual(await readExplanation(stream, (event) => { phases.push(event.phase); assert.equal(event.timeoutMs, 5000); }), result);
  assert.deepEqual(phases, ["starting", "running"]);
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "result", result }) + "\n");
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "content-type": "application/x-ndjson" } });
  assert.deepEqual(await readExplanation(response, () => {}), result);
});

test("explanation stream sanitizes unexpected diagnostics and rejects incomplete streams", async () => {
  await assert.rejects(readExplanation(explanationStream(new AbortController().signal, 5000, async () => { throw new Error("private diagnostic"); }), () => {}), (error: Error) => {
    assert.equal(error.message, "生成讲解失败，请重试"); return true;
  });
  await assert.rejects(readExplanation(explanationStream(new AbortController().signal, 5000, async () => { throw new AiError("Agent 运行超时", 504); }), () => {}), /超时/);
  await assert.rejects(readExplanation(new Response('{"type":"progress","phase":"running","elapsedMs":1,"timeoutMs":2}\n', { headers: { "content-type": "application/x-ndjson" } }), () => {}), /提前结束/);
});

test("disconnecting the stream or aborting the request aborts its underlying Agent work", async () => {
  for (const disconnect of [true, false]) {
    const request = new AbortController();
    let notify!: () => void;
    const stopped = new Promise<void>((resolve) => { notify = resolve; });
    const response = explanationStream(request.signal, 5000, (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { notify(); reject(new AiError("已取消", 499)); }, { once: true });
    }));
    if (disconnect) await response.body!.cancel(); else request.abort();
    await stopped;
  }
});

test("delta events reach the reader in order and JSON replies carry no deltas", async () => {
  const deltas: string[] = [];
  const stream = explanationStream(new AbortController().signal, undefined, async (_signal, progress, delta) => {
    progress("running"); delta("第一段"); delta("第二段"); return result;
  });
  assert.deepEqual(await readExplanation(stream, (event) => { assert.equal(event.timeoutMs, undefined); }, (text) => deltas.push(text)), result);
  assert.deepEqual(deltas, ["第一段", "第二段"]);
  const fromJson: string[] = [];
  assert.deepEqual(await readExplanation(Response.json(result), () => {}, (text) => fromJson.push(text)), result);
  assert.deepEqual(fromJson, []);
});

test("cached JSON replies and nonstream API errors remain compatible", async () => {
  assert.deepEqual(await readExplanation(Response.json({ ...result, cached: true }), () => {}), { ...result, cached: true });
  await assert.rejects(readExplanation(Response.json({ error: "未配置" }, { status: 503 }), () => {}), /未配置/);
});

test("safe retry states travel through the stream before the final result", async () => {
  const waiting: ChatRetryState = { attempt: 2, maxAttempts: 3, reason: "rate-limit", retryAt: Date.now() + 60_000 };
  const retries: ChatRetryState[] = [];
  const stream = explanationStream(new AbortController().signal, undefined, async (_signal, _progress, _delta, retry) => {
    retry(waiting);
    retry({ ...waiting, retryAt: null });
    return result;
  });
  assert.deepEqual(await readExplanation(stream, () => {}, undefined, (retry) => retries.push(retry)), result);
  assert.deepEqual(retries, [waiting, { ...waiting, retryAt: null }]);
});
