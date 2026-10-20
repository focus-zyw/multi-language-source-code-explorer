import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { completeChat, type ChatConfig } from "../src/lib/ai-chat.ts";
import type { ChatRetryState } from "../src/lib/ai-types.ts";

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
    res.end('data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\ndata: [DONE]\n\n');
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
    await assert.rejects(completeChat(config(), "system", "source", undefined, { maxAttempts: 2 }), (error) => {
      assert.match((error as Error).message, /超时/);
      assert.equal((error as { status: number }).status, 504);
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.AI_IDLE_TIMEOUT_MS;
    else process.env.AI_IDLE_TIMEOUT_MS = previous;
  }
});

for (const provider of ["openai", "anthropic"] as const) {
  const content = provider === "openai"
    ? 'data: {"choices":[{"delta":{"content":"部分正文"}}]}\n\n'
    : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"部分正文"}}\n\n';
  const completion = provider === "openai" ? "data: [DONE]\n\n" : 'data: {"type":"message_stop"}\n\n';

  test(`${provider} rejects EOF without its completion marker`, async () => {
    route((res) => { res.writeHead(200, SSE); res.end(content); });
    const deltas: string[] = [];
    await assert.rejects(completeChat(config(provider), "system", "source", undefined, {
      onDelta: (chunk) => deltas.push(chunk),
    }), /提前结束/);
    assert.deepEqual(deltas, ["部分正文"]);
    assert.equal(calls, 1);
  });

  test(`${provider} completes and cancels the reader before HTTP EOF`, { timeout: 5000 }, async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    route((res) => {
      res.writeHead(200, SSE);
      res.on("close", disconnected);
      res.write(content + completion);
      // 故意不结束 HTTP 响应，完成标记之后的正文也不应再被接收。
      res.write(content);
    });
    assert.equal(await completeChat(config(provider), "system", "source"), "部分正文");
    await closed;
    assert.equal(calls, 1);
  });
}

test("retries a timeout before content and succeeds on the next attempt", async () => {
  route((res) => {
    res.writeHead(200, SSE);
    if (calls === 1) { res.flushHeaders(); return; }
    res.end('data: {"choices":[{"delta":{"content":"恢复成功"}}]}\n\ndata: [DONE]\n\n');
  });
  const previous = process.env.AI_IDLE_TIMEOUT_MS;
  process.env.AI_IDLE_TIMEOUT_MS = "1000";
  try {
    assert.equal(await completeChat(config(), "system", "source", undefined, { maxAttempts: 2 }), "恢复成功");
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.AI_IDLE_TIMEOUT_MS;
    else process.env.AI_IDLE_TIMEOUT_MS = previous;
  }
});

test("does not retry a timeout after emitting content", async () => {
  route((res) => {
    res.writeHead(200, SSE);
    res.write('data: {"choices":[{"delta":{"content":"部分正文"}}]}\n\n');
  });
  const previous = process.env.AI_IDLE_TIMEOUT_MS;
  process.env.AI_IDLE_TIMEOUT_MS = "1000";
  try {
    await assert.rejects(completeChat(config(), "system", "source", undefined, { maxAttempts: 3 }), /超时/);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.AI_IDLE_TIMEOUT_MS;
    else process.env.AI_IDLE_TIMEOUT_MS = previous;
  }
});

test("keeps receiving an active stream beyond AI_TIMEOUT_MS", { timeout: 10_000 }, async () => {
  route((res) => {
    res.writeHead(200, SSE);
    res.write('data: {"choices":[{"delta":{"content":"完整正文"}}]}\n\n');
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 200);
    const finish = setTimeout(() => res.end("data: [DONE]\n\n"), 5500);
    res.on("close", () => { clearInterval(heartbeat); clearTimeout(finish); });
  });
  const previousTimeout = process.env.AI_TIMEOUT_MS;
  const previousIdle = process.env.AI_IDLE_TIMEOUT_MS;
  process.env.AI_TIMEOUT_MS = "5000";
  process.env.AI_IDLE_TIMEOUT_MS = "1000";
  try {
    assert.equal(await completeChat(config(), "system", "source"), "完整正文");
    assert.equal(calls, 1);
  } finally {
    if (previousTimeout === undefined) delete process.env.AI_TIMEOUT_MS;
    else process.env.AI_TIMEOUT_MS = previousTimeout;
    if (previousIdle === undefined) delete process.env.AI_IDLE_TIMEOUT_MS;
    else process.env.AI_IDLE_TIMEOUT_MS = previousIdle;
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

for (const provider of ["openai", "anthropic"] as const) {
  for (const stream of [true, false]) {
    test(`${provider} rejects explicit truncation in ${stream ? "SSE" : "JSON"} without retrying`, async () => {
      route((res) => {
        if (stream) {
          res.writeHead(200, SSE);
          res.end(provider === "openai"
            ? 'data: {"choices":[{"delta":{"content":"半句"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
            : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半句"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\ndata: {"type":"message_stop"}\n\n');
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(provider === "openai"
            ? { choices: [{ message: { content: "半句" }, finish_reason: "length" }] }
            : { content: [{ type: "text", text: "半句" }], stop_reason: "max_tokens" }));
        }
      });
      await assert.rejects(completeChat(config(provider), "system", "source"), /长度上限/);
      assert.equal(calls, 1);
    });
  }

  test(`${provider} accepts an explicit successful finish reason`, async () => {
    route((res) => {
      res.writeHead(200, SSE);
      res.end(provider === "openai"
        ? 'data: {"choices":[{"delta":{"content":"完整"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"完整"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
    });
    assert.equal(await completeChat(config(provider), "system", "source"), "完整");
  });
}

test("rejects filtered and tool-request responses without exposing the upstream reason", async () => {
  for (const reason of ["content_filter", "tool_calls", "private-provider-reason"]) {
    route((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "片段" }, finish_reason: reason }] }));
    });
    await assert.rejects(completeChat(config(), "system", "source"), (error: Error) => {
      assert.match(error.message, /未正常完成/);
      assert.ok(!error.message.includes(reason));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("honors Retry-After beyond the local eight-second backoff cap", { timeout: 15_000 }, async () => {
  route((res) => {
    if (calls === 1) { res.writeHead(429, { "retry-after": "9" }); res.end("private upstream diagnostic"); return; }
    res.writeHead(200, SSE);
    res.end('data: {"choices":[{"delta":{"content":"恢复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const retries: ChatRetryState[] = [];
  const started = performance.now();
  assert.equal(await completeChat(config(), "system", "source", undefined, { onRetry: (retry) => retries.push(retry) }), "恢复");
  assert.ok(performance.now() - started >= 8900);
  assert.equal(calls, 2);
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[0], { attempt: 2, maxAttempts: 3, reason: "rate-limit", retryAt: retries[0].retryAt });
  assert.ok(retries[0].retryAt! > Date.now() - 1000);
  assert.equal(retries[1].retryAt, null);
  assert.ok(!JSON.stringify(retries).includes("private"));
});

test("manual stop interrupts Retry-After immediately and starts no further requests", async () => {
  route((res) => { res.writeHead(429, { "retry-after": "60" }); res.end("{}"); });
  const controller = new AbortController();
  let retryAt = 0;
  const started = Date.now();
  await assert.rejects(completeChat(config(), "system", "source", controller.signal, {
    onRetry: (retry) => { retryAt = retry.retryAt!; controller.abort(); },
  }), /取消/);
  assert.ok(retryAt - started >= 59_000);
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls, 1);
});

test("Retry-After HTTP dates expire from header receipt while the error body is read", async () => {
  const requestedAt = Date.now();
  const retryAt = Math.ceil(requestedAt / 1000) * 1000 + 2000;
  route((res) => {
    if (calls === 1) {
      res.writeHead(503, { "retry-after": new Date(retryAt).toUTCString() });
      res.flushHeaders();
      setTimeout(() => res.end("{}"), 500);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "恢复" }, finish_reason: "stop" }] }));
  });
  const retries: ChatRetryState[] = [];
  assert.equal(await completeChat(config(), "system", "source", undefined, { onRetry: (retry) => retries.push(retry) }), "恢复");
  assert.ok(Date.now() >= retryAt - 30);
  assert.ok(Math.abs(retries[0].retryAt! - retryAt) < 100);
  assert.equal(calls, 2);
});
