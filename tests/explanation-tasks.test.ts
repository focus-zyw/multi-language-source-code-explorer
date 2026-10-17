import assert from "node:assert/strict";
import { test } from "node:test";
import { createExplanationTasks, explanationTaskKey } from "../src/lib/explanation-tasks.ts";
import type { ExplanationResponse } from "../src/lib/ai-types.ts";

const input = { projectId: 1, symbolId: 2, symbolName: "double", backend: "agent" as const, force: false };
const key = explanationTaskKey(1, 2, "agent");
const result: ExplanationResponse = { explanation: "double 的讲解", backend: "agent", model: "fixture", generatedAt: "2026-10-17T00:00:00.000Z", cached: false };
function harness() {
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void; body: unknown }[] = [];
  const store = createExplanationTasks((url, init) => new Promise((resolve) => {
    requests.push({ url: String(url), signal: init!.signal!, resolve, body: JSON.parse(String(init!.body)) });
  }));
  return { store, requests };
}

test("unmounting every subscriber and navigating away does not abort generation; completion belongs to its original method", async () => {
  const { store, requests } = harness();
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  let saved: ExplanationResponse | undefined;
  const pending = store.start(input, (value) => { saved = value; });
  await Promise.resolve();
  assert.equal(requests[0].url, "/api/projects/1/symbols/2/explain");
  unsubscribe(); // The panel's useSyncExternalStore cleanup, including all views unmounting.
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(Response.json(result));
  await pending;
  assert.equal(updates, 1);
  assert.deepEqual(saved, result);
  assert.equal(store.get(key)?.loading, false);
  assert.deepEqual(store.get(key)?.result, result); // Remount sees the finished result immediately.
});

test("switching methods/backends keeps separate tasks and deduplicates an already running request", async () => {
  const { store, requests } = harness();
  const first = store.start(input);
  assert.equal(store.start({ ...input, force: true }), first);
  const other = store.start({ ...input, symbolId: 3, symbolName: "triple" });
  const api = store.start({ ...input, backend: "api" });
  const project = store.start({ ...input, projectId: 4 });
  await Promise.resolve();
  assert.equal(requests.length, 4);
  assert.equal(requests.every((request) => !request.signal.aborted), true);
  for (const [index, request] of requests.entries()) request.resolve(Response.json({ ...result, explanation: String(index) }));
  await Promise.all([first, other, api, project]);
  assert.equal(store.get(key)?.result?.explanation, "0");
  assert.equal(store.get(explanationTaskKey(1, 3, "agent"))?.result?.explanation, "1");
  assert.equal(store.get(explanationTaskKey(1, 2, "api"))?.result?.explanation, "2");
  assert.equal(store.get(explanationTaskKey(4, 2, "agent"))?.result?.explanation, "3");
});

test("manual stop aborts only the chosen task; a late old result cannot overwrite a retry", async () => {
  const { store, requests } = harness();
  let oldCompleted = false;
  const old = store.start(input, () => { oldCompleted = true; });
  const other = store.start({ ...input, symbolId: 3 });
  await Promise.resolve();
  store.stop(key);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(store.get(key)?.phase, "cancelled");
  const retry = store.start(input);
  await Promise.resolve();
  requests[0].resolve(Response.json({ ...result, explanation: "old" }));
  await old;
  assert.equal(oldCompleted, false);
  assert.equal(store.get(key)?.loading, true);
  assert.equal(store.get(key)?.result, undefined);
  requests[2].resolve(Response.json({ ...result, explanation: "retry" }));
  requests[1].resolve(Response.json(result));
  await Promise.all([retry, other]);
  assert.equal(store.get(key)?.result?.explanation, "retry");
});

test("progress continues without subscribers, then a remounted view can manually stop its stream", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const store = createExplanationTasks(async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({ start(controller) {
      streamController = controller;
      signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    } }), { headers: { "content-type": "application/x-ndjson" } });
  });
  const unsubscribe = store.subscribe(() => {});
  const pending = store.start(input);
  await Promise.resolve();
  unsubscribe();
  streamController.enqueue(new TextEncoder().encode(JSON.stringify({ type: "progress", phase: "running", timeoutMs: 300000, elapsedMs: 10 }) + "\n"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(key)?.phase, "running");
  assert.equal(store.get(key)?.timeoutMs, 300000);
  const unmount = store.subscribe(() => {});
  store.stop(key);
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(store.get(key)?.phase, "cancelled");
  assert.equal(store.get(key)?.error, null);
  unmount();
});

test("API tasks also stop explicitly; dismissing a running task cannot remove its stop control", async () => {
  const { store, requests } = harness();
  const apiKey = explanationTaskKey(1, 2, "api");
  const pending = store.start({ ...input, backend: "api" });
  await Promise.resolve();
  store.dismiss(apiKey);
  assert.equal(store.get(apiKey)?.dismissed, false);
  store.stop(apiKey);
  requests[0].resolve(Response.json(result));
  await pending;
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(store.get(apiKey)?.result, undefined);
  store.dismiss(apiKey);
  assert.equal(store.get(apiKey)?.dismissed, true);
});

test("failures remain inspectable after returning to the panel and retry preserves the previous result", async () => {
  const { store, requests } = harness();
  const initial = store.start(input);
  await Promise.resolve();
  requests[0].resolve(Response.json(result));
  await initial;
  const retry = store.start({ ...input, force: true });
  await Promise.resolve();
  assert.deepEqual(requests[1].body, { force: true, backend: "agent", stream: true });
  requests[1].resolve(Response.json({ error: "服务暂不可用" }, { status: 503 }));
  await retry;
  assert.equal(store.get(key)?.error, "服务暂不可用");
  assert.equal(store.get(key)?.loading, false);
  assert.deepEqual(store.get(key)?.result, result);
});
