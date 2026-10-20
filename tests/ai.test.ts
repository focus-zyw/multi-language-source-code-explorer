import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { completeChat, type ChatConfig } from "../src/lib/ai-chat.ts";

// 本地桩服务：不连接任何模型，只验证流式解析、重试与取消。
const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" };
let handler: ((res: ServerResponse) => void) | null = null;
let calls = 0;

const server = createServer((req, res) => {
  req.resume();
  calls++;
  if (!handler) { res.statusCode = 404; res.end("{}"); return; }
  handler(res);
});

let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 每个用例只使用一个上游行为，并重置计数。 */
function route(next: (res: ServerResponse) => void) {
  handler = next;
  calls = 0;
}

function config(provider: ChatConfig["provider"] = "openai"): ChatConfig {
  return { provider, apiKey: "test-only-key", baseUrl, model: "test-model" };
}

test("parses fragmented SSE deltas and reports them in order", async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  route((res) => {
    res.writeHead(200, SSE);
    res.write(frames.slice(0, 20));
    res.write(frames.slice(20, 47));
    res.end(frames.slice(47));
  });
  const deltas: string[] = [];
  const text = await completeChat(config(), "system", "source", undefined, { onDelta: (chunk) => deltas.push(chunk) });
  assert.equal(text, "你好");
  assert.deepEqual(deltas, ["你", "好"]);
});

test("reads Anthropic text deltas and ignores non-text events", async () => {
  route((res) => {
    res.writeHead(200, SSE);
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"分段"}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"讲解"}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  assert.equal(await completeChat(config("anthropic"), "system", "source"), "分段讲解");
});

test("accepts a JSON body from endpoints that ignore stream", async () => {
  route((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "整段讲解" } }] }));
  });
  const deltas: string[] = [];
  assert.equal(await completeChat(config(), "system", "source", undefined, { onDelta: (chunk) => deltas.push(chunk) }), "整段讲解");
  assert.deepEqual(deltas, ["整段讲解"]);
});

test("retries a rate-limited request and honors Retry-After", async () => {
  let attempt = 0;
  route((res) => {
    attempt++;
    if (attempt === 1) { res.writeHead(429, { "retry-after": "0" }); res.end("{}"); return; }
    res.writeHead(200, SSE);
    res.end('data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\n');
  });
  assert.equal(await completeChat(config(), "system", "source"), "重试成功");
  assert.equal(calls, 2);
});

test("stops after the attempt budget and reports the upstream status", async () => {
  route((res) => { res.writeHead(500, { "retry-after": "0" }); res.end("{}"); });
  await assert.rejects(completeChat(config(), "system", "source", undefined, { maxAttempts: 2 }), /HTTP 500/);
  assert.equal(calls, 2);
});

test("does not retry authentication failures", async () => {
  route((res) => { res.writeHead(401); res.end("{}"); });
  await assert.rejects(completeChat(config(), "system", "source"), /拒绝了请求/);
  assert.equal(calls, 1);
});

test("reports a stalled stream as a timeout instead of waiting forever", async () => {
  route((res) => { res.writeHead(200, SSE); res.flushHeaders(); });
  const previous = process.env.AI_IDLE_TIMEOUT_MS;
  process.env.AI_IDLE_TIMEOUT_MS = "1000";
  try {
    await assert.rejects(completeChat(config(), "system", "source"), /超时/);
  } finally {
    if (previous === undefined) delete process.env.AI_IDLE_TIMEOUT_MS;
    else process.env.AI_IDLE_TIMEOUT_MS = previous;
  }
});

test("cancels a running stream when the caller aborts", async () => {
  route((res) => {
    res.writeHead(200, SSE);
    res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
  });
  const controller = new AbortController();
  const promise = completeChat(config(), "system", "source", controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, /取消/);
});

test("reports an unreachable endpoint without leaking diagnostics", async () => {
  const unreachable = { ...config(), baseUrl: "http://127.0.0.1:1" };
  await assert.rejects(completeChat(unreachable, "system", "source", undefined, { maxAttempts: 1 }), (error: Error) => {
    assert.match(error.message, /无法连接模型服务/);
    assert.ok(!error.message.includes("test-only-key"));
    return true;
  });
});
