import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuestionTasks, questionTaskKey } from "../src/lib/question-tasks.ts";

test("question requests survive unsubscribe, remain scoped, and reload saved history", async () => {
  let finish!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  let requests = 0;
  const tasks = createQuestionTasks(async (_url, init) => {
    if (init?.method !== "POST") return Response.json({ identity: "identity", fingerprint: "a".repeat(64), backend: "agent", turns: [] });
    requests++; signal = init.signal;
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  await tasks.load(1, 2, "agent");
  const unsubscribe = tasks.subscribe(() => {});
  const pending = tasks.start(1, 2, { backend: "agent", question: "why", fingerprint: "a".repeat(64), requestId: "request-1" });
  unsubscribe();
  await tasks.start(1, 2, { backend: "agent", question: "duplicate", fingerprint: "a".repeat(64), requestId: "request-2" });
  assert.equal(requests, 1);
  assert.equal(signal?.aborted, false);
  await tasks.load(1, 3, "api");
  assert.equal(tasks.get(questionTaskKey(1, 2, "agent"))?.loading, true);
  assert.equal(tasks.get(questionTaskKey(1, 3, "api"))?.loading, false);
  finish(Response.json({ explanation: "answer", backend: "agent", model: "fixture", generatedAt: null, cached: false }));
  await pending;
  assert.equal(tasks.get(questionTaskKey(1, 2, "agent"))?.phase, "已保存");
});

test("only manual stop aborts a question request", async () => {
  let signal: AbortSignal | null | undefined;
  const tasks = createQuestionTasks(async (_url, init) => {
    if (init?.method !== "POST") return Response.json({ identity: "identity", fingerprint: "a".repeat(64), backend: "api", turns: [] });
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
  });
  await tasks.load(1, 2, "api");
  const pending = tasks.start(1, 2, { backend: "api", question: "why", fingerprint: "a".repeat(64), requestId: "request-1" });
  tasks.stop(questionTaskKey(1, 2, "api"));
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(tasks.get(questionTaskKey(1, 2, "api"))?.phase, "已停止");
  assert.equal(tasks.get(questionTaskKey(1, 2, "api"))?.error, null);
});
