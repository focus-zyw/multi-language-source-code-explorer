import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
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
  let holdNextApi;
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.ok(payload.messages.some((message) => message.content.includes("double")));
    apiCalls++;
    if (holdNextApi) {
      const held = holdNextApi;
      holdNextApi = null;
      res.once("close", held.disconnected);
      held.started();
      return;
    }
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
    const base = `http://localhost:${port}`;
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
    // Manual cancellation propagates to the upstream API and preserves the old cache.
    const beforeCancel = (await (await fetch(path)).json()).ai.explanations.api;
    let notifyStarted, notifyDisconnected;
    const apiStarted = new Promise((resolve) => { notifyStarted = resolve; });
    const apiDisconnected = new Promise((resolve) => { notifyDisconnected = resolve; });
    holdNextApi = { started: notifyStarted, disconnected: notifyDisconnected };
    const controller = new AbortController();
    const cancelled = fetch(`${path}/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "api", force: true }), signal: controller.signal });
    const didCancel = assert.rejects(cancelled, { name: "AbortError" });
    await Promise.race([apiStarted, delay(5000).then(() => { throw new Error("API fixture did not start"); })]);
    controller.abort();
    await didCancel;
    await Promise.race([apiDisconnected, delay(5000).then(() => { throw new Error("Upstream API was not cancelled"); })]);
    assert.deepEqual((await (await fetch(path)).json()).ai.explanations.api, beforeCancel);
    const progressReply = await fetch(`${path}/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "agent", force: true, stream: true }) });
    assert.match(progressReply.headers.get("content-type"), /application\/x-ndjson/);
    const events = (await progressReply.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((event) => event.type === "progress").map((event) => event.phase), ["starting", "running", "responding", "finishing"]);
    assert.equal(events.at(-1).type, "result");
    assert.ok(events.at(-1).result.explanation.includes("Agent 测试讲解"));
    assert.equal(JSON.stringify(events).includes("private"), false);

    // A rescan replaces symbol IDs but retains explanations whose content fingerprint matches.
    const sourceDir = join(temp, "source");
    await mkdir(sourceDir);
    const unchanged = "export function double(value) { return value * 2; }";
    const changed = "export function doubleChanged(value) { return value + 1; }";
    const legacy = "export function doubleLegacy(value) { return value - 1; }";
    await writeFile(join(sourceDir, "main.js"), [unchanged, changed, legacy].join("\n"));
    const local = await (await fetch(`${base}/api/projects/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "import", path: sourceDir }) })).json();
    assert.ok(local.id, JSON.stringify(local));
    const localTree = async () => (await fetch(`${base}/api/projects/${local.id}/tree`)).json();
    const before = await localTree();
    const findId = (data, name) => data.symbols.find((symbol) => symbol.name === name).id;
    const generate = async (id, backend) => {
      const response = await fetch(`${base}/api/projects/${local.id}/symbols/${id}/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend }) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
    };
    const detailAt = async (id) => (await fetch(`${base}/api/projects/${local.id}/symbols/${id}`)).json();
    const rescan = async () => { const response = await fetch(`${base}/api/projects/${local.id}/rescan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body; };
    const apiKeep = await generate(findId(before, "double"), "api");
    const agentKeep = await generate(findId(before, "double"), "agent");
    await generate(findId(before, "doubleChanged"), "api");
    await generate(findId(before, "doubleLegacy"), "api");
    const database = createClient({ url: env.DATABASE_URL });
    try {
      // Emulate an existing explanation created before fingerprint support.
      await database.execute({ sql: "update symbol_explanations set config_key = substr(config_key, 1, instr(config_key, ':content-v1:') - 1) where symbol_id = ?", args: [findId(before, "doubleLegacy")] });
      assert.equal((await rescan()).preservedExplanations, 4);
      const same = await localTree();
      assert.notEqual(findId(same, "double"), findId(before, "double"));
      assert.equal((await generate(findId(same, "doubleLegacy"), "api")).cached, true);
      await database.execute(`create trigger cache_restore_failure before insert on symbol_explanations when (select project_id from symbols where id = NEW.symbol_id) = ${local.id} begin select raise(abort, 'cache restore rollback test'); end`);
      try {
        const failed = await fetch(`${base}/api/projects/${local.id}/rescan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(failed.status, 500);
        assert.deepEqual(await localTree(), same);
        assert.equal((await detailAt(findId(same, "double"))).ai.explanations.api.generatedAt, apiKeep.generatedAt);
      } finally { await database.execute("drop trigger cache_restore_failure"); }

      await writeFile(join(sourceDir, "main.js"), ["// inserted before unchanged functions", unchanged, changed.replace("+ 1", "+ 2"), legacy].join("\n"));
      await writeFile(join(sourceDir, "unrelated.js"), "export function unused() { return 9; }");
      const callsBeforeRescan = apiCalls;
      assert.equal((await rescan()).preservedExplanations, 2);
      const after = await localTree();
      const kept = await detailAt(findId(after, "double"));
      assert.equal(kept.ai.explanations.api.explanation, apiKeep.explanation);
      assert.equal(kept.ai.explanations.api.generatedAt, apiKeep.generatedAt);
      assert.equal(kept.ai.explanations.agent.generatedAt, agentKeep.generatedAt);
      assert.equal(kept.ai.explanations.api.relativeLines, true);
      assert.deepEqual((await detailAt(findId(after, "doubleChanged"))).ai.explanations, {});
      assert.deepEqual((await detailAt(findId(after, "doubleLegacy"))).ai.explanations, {});
      assert.equal((await generate(findId(after, "double"), "api")).cached, true);
      assert.equal((await generate(findId(after, "double"), "agent")).cached, true);
      assert.equal(apiCalls, callsBeforeRescan);

      // Same caller source, different import target: do not reuse the explanation.
      await writeFile(join(sourceDir, "a.js"), "export function helper(value) { return value; }");
      await writeFile(join(sourceDir, "b.js"), "export function helper(value) { return value * 3; }");
      const caller = "export function doubleCaller(value) { return helper(value); }";
      await writeFile(join(sourceDir, "caller.js"), `import { helper } from './a.js';\n${caller}`);
      await rescan();
      const firstCaller = findId(await localTree(), "doubleCaller");
      await generate(firstCaller, "api");
      await writeFile(join(sourceDir, "caller.js"), `import { helper } from './b.js';\n${caller}`);
      await rescan();
      assert.deepEqual((await detailAt(findId(await localTree(), "doubleCaller"))).ai.explanations, {});
      const legacyColumnId = findId(await localTree(), "doubleLegacy");
      await database.execute({ sql: "update symbols set ai_explanation = ?, ai_model = ?, ai_generated_at = ? where id = ?", args: ["Legacy column explanation", "api-fixture", Date.now(), legacyColumnId] });
      await rescan();
      assert.equal((await detailAt(findId(await localTree(), "doubleLegacy"))).ai.explanations.api.explanation, "Legacy column explanation");
      const duplicateSource = "function doubleDuplicate(value) { return value; }";
      await writeFile(join(sourceDir, "duplicate.js"), `${duplicateSource}\n${duplicateSource}`);
      await rescan();
      const duplicateSymbols = (await localTree()).symbols.filter((symbol) => symbol.name === "doubleDuplicate");
      assert.equal(duplicateSymbols.length, 2);
      for (const symbol of duplicateSymbols) await generate(symbol.id, "api");
      await writeFile(join(sourceDir, "duplicate.js"), duplicateSource);
      await rescan();
      assert.deepEqual((await detailAt(findId(await localTree(), "doubleDuplicate"))).ai.explanations, {});
    } finally { database.close(); }
  } finally {
    if (app && app.exitCode === null) {
      const closed = once(app, "close");
      app.kill();
      await closed;
    }
    await new Promise((resolve) => api.close(resolve));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
