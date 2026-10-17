import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Uses a temporary database, a local API fixture and a deterministic Agent process.
test("production app supports both explanation backends with independent persistent caches", {
  skip: process.env.RUN_BACKEND_E2E !== "1", timeout: 60_000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "code-atlas-backends-"));
  let apiCalls = 0;
  let startup = "";
  let app;
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.ok(payload.messages.some((message) => message.content.includes("double")));
    apiCalls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "## 一句话概述\nAPI 测试讲解：输入乘以二。" } }] }));
  });
  try {
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const reserve = createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: pathToFileURL(join(temp, "app.db")).href,
      AI_API_KEY: "local-fixture-only", AI_PROVIDER: "openai", AI_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`,
      AI_MODEL: "api-fixture", AI_AGENT_ENABLED: "true", AI_AGENT_COMMAND: fileURLToPath(new URL("./support/agent-runner.mjs", import.meta.url)),
      AI_AGENT_MODEL: "integration", AI_EXPLAIN_BACKEND: "api" };
    delete env.__NEXT_PROCESSED_ENV;
    const push = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "push"], { env, stdio: "pipe", windowsHide: true });
    push.stdout.resume();
    push.stderr.resume();
    assert.equal((await once(push, "close"))[0], 0);
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
    for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => { startup = (startup + chunk).slice(-5000); });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* Wait for startup. */ }
      await delay(250);
    }
    assert.ok(ready, startup);
    const form = new FormData();
    form.set("mode", "folder");
    form.set("name", "Backend fixtures");
    form.set("paths", '["double.js"]');
    form.append("files", new Blob(["export function double(value) { return value * 2; }"]), "double.js");
    const imported = await (await fetch(`${base}/api/projects`, { method: "POST", body: form })).json();
    const tree = await (await fetch(`${base}/api/projects/${imported.id}/tree`)).json();
    assert.equal(tree.symbols.length, 1, JSON.stringify(imported));
    const path = `${base}/api/projects/${imported.id}/symbols/${tree.symbols[0].id}`;
    async function explain(backend, force = false) {
      const response = await fetch(`${path}/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend, force }) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    }
    const apiResult = await explain("api");
    const agentResult = await explain("agent");
    assert.equal(apiResult.cached, false);
    assert.equal(agentResult.cached, false);
    assert.ok(apiResult.explanation.includes("API 测试讲解"));
    assert.ok(agentResult.explanation.includes("Agent 测试讲解"));
    assert.equal((await explain("api")).cached, true);
    assert.equal((await explain("agent")).cached, true);
    assert.equal(apiCalls, 1);
    const detail = await (await fetch(path)).json();
    assert.equal(detail.ai.explanations.api.explanation, apiResult.explanation);
    assert.equal(detail.ai.explanations.agent.explanation, agentResult.explanation);
    assert.equal(detail.ai.backends.api.available, true);
    assert.equal(detail.ai.backends.agent.available, true);
    assert.equal((await explain("api", true)).cached, false);
    assert.equal(apiCalls, 2);
  } finally {
    if (app && app.exitCode === null) {
      const closed = once(app, "close");
      app.kill();
      await closed;
    }
    await new Promise((resolve) => api.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
