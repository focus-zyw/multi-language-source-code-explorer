// Production build required. Uses an isolated DB and mock API/Agent; never real models.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("questions persist, isolate sources, follow rescans, stop explicitly and validate context", { skip: process.env.RUN_QUESTIONS_E2E !== "1", timeout: process.env.QUESTIONS_UI_PATH ? 300000 : 90000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-questions-"));
  let app, database, hold, started, disconnected;
  const prompts = [];
  const api = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const prompt = JSON.parse(request.messages.at(-1).content);
    prompts.push(prompt);
    if (hold) { hold = false; res.once("close", () => disconnected?.()); started?.(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "【源码事实】返回输入的两倍。见 [返回语句](source:0:2)。\n\n【信息不足】调用方如何使用结果，需补充代码。" } }] }));
  });
  try {
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const reserve = createServer(); await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: pathToFileURL(join(temp, "app.db")).href, AI_API_KEY: "fixture-only", AI_PROVIDER: "openai", AI_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`, AI_MODEL: "fixture-model", AI_AGENT_ENABLED: "true", AI_AGENT_COMMAND: fileURLToPath(new URL("./support/agent-runner.mjs", import.meta.url)), AI_AGENT_MODEL: "integration", AI_EXPLAIN_BACKEND: "api" };
    delete env.__NEXT_PROCESSED_ENV;
    const push = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "push"], { env, stdio: "pipe", windowsHide: true }); push.stdout.resume(); push.stderr.resume(); assert.equal((await once(push, "close"))[0], 0);
    database = createClient({ url: env.DATABASE_URL });
    // Exercise additive first-use creation against an older database.
    await database.execute("drop table symbol_questions");
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
    app.stdout.resume(); app.stderr.resume();
    const base = `http://localhost:${port}`;
    let ready = false; for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(200); }
    assert.ok(ready);
    const dir = join(temp, "source"); await mkdir(dir);
    const code = "export function double(value) {\n  return helper(value);\n}\nexport function helper(value) {\n  return value * 2;\n}\n";
    await writeFile(join(dir, "main.js"), code);
    const local = await (await fetch(`${base}/api/projects/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "import", path: dir }) })).json();
    assert.ok(local.id);
    const getTree = async () => (await fetch(`${base}/api/projects/${local.id}/tree`)).json();
    let tree = await getTree();
    const find = (name) => tree.symbols.find((s) => s.name === name).id;
    let sid = find("double");
    const endpoint = () => `${base}/api/projects/${local.id}/symbols/${sid}/questions`;
    const history = async (backend = "api") => { const reply = await fetch(`${endpoint()}?backend=${backend}`); assert.equal(reply.status, 200); return reply.json(); };
    const post = async (patch = {}) => {
      const h = await history(patch.backend ?? "api");
      const reply = await fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "api", question: "为什么？", fingerprint: h.fingerprint, requestId: crypto.randomUUID(), ...patch }) });
      const text = await reply.text();
      if (reply.ok) { const events = text.trim().split("\n").map((line) => JSON.parse(line)); assert.equal(events.at(-1).type, "result", text); return events.at(-1).result; }
      return { status: reply.status, ...JSON.parse(text) };
    };
    assert.equal((await history()).turns.length, 0);
    await post({ question: "解释选区", quote: { kind: "code", text: "return helper(value)", startLine: 2, endLine: 2 }, relatedIds: [find("helper")] });
    let h = await history(); assert.equal(h.turns.length, 1); assert.equal(h.turns[0].status, "completed"); assert.equal(h.turns[0].outdated, false);
    assert.equal(prompts[0].sources.length, 2); assert.ok(prompts[0].sources[1].code.includes("value * 2"));
    await post({ question: "继续解释", relatedIds: [find("helper")] });
    assert.equal(prompts[1].history.length, 1);
    assert.equal(prompts[1].quote, null);
    assert.equal((await history("agent")).turns.length, 0);
    const agent = await post({ backend: "agent" }); assert.ok(agent.explanation.includes("Agent 测试讲解"));
    assert.equal((await history("agent")).turns.length, 1);
    assert.equal((await post({ fingerprint: "b".repeat(64) })).status, 409);
    assert.equal((await post({ relatedIds: [99999999] })).status, 400);
    const foreignReply = await fetch(endpoint(), { method: "POST", headers: { origin: "https://foreign.invalid", "content-type": "application/json" }, body: "{}" }); assert.equal(foreignReply.status, 403);
    // Manual abort closes the upstream connection and persists cancelled status.
    const began = new Promise((resolve) => { started = resolve; });
    const closed = new Promise((resolve) => { disconnected = resolve; }); hold = true;
    const controller = new AbortController();
    const request = fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "api", question: "停止这个问题", fingerprint: (await history()).fingerprint, requestId: crypto.randomUUID() }), signal: controller.signal });
    const reply = await request; const reading = reply.text(); const rejected = assert.rejects(reading);
    await Promise.race([began, delay(5000).then(() => { throw Error("upstream never started"); })]); controller.abort(); await rejected;
    await Promise.race([closed, delay(5000).then(() => { throw Error("upstream not cancelled"); })]);
    for (let i = 0; i < 30 && (await history()).turns.at(-1).status === "pending"; i++) await delay(100);
    assert.equal((await history()).turns.at(-1).status, "cancelled");
    const rescan = async () => { const response = await fetch(`${base}/api/projects/${local.id}/rescan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(response.status, 200, await response.text()); tree = await getTree(); sid = find("double"); };
    const oldSid = sid;
    await writeFile(join(dir, "main.js"), "// inserted\n" + code); await rescan(); assert.notEqual(sid, oldSid);
    h = await history(); assert.equal(h.turns.length, 3); assert.equal(h.turns[0].outdated, false); assert.equal(h.turns[0].sources[0].symbolId, sid); assert.equal(h.turns[0].sources[0].startLine, 2); assert.equal(h.turns[0].quote.startLine, 3);
    await writeFile(join(dir, "main.js"), code.replace("helper(value);", "helper(value) + 1;")); await rescan();
    h = await history(); assert.equal(h.turns[0].outdated, true);
    await post({ question: "新代码怎么做？" }); assert.equal(prompts.at(-1).history.length, 0);
    assert.equal((await history()).turns.at(-1).outdated, false);
    // A duplicate request ID cannot run the model twice.
    const requestId = crypto.randomUUID(); await post({ requestId }); const count = prompts.length;
    assert.equal((await post({ requestId })).status, 409); assert.equal(prompts.length, count);
    // A changed supplemental method invalidates only turns that relied on it.
    await post({ question: "补充 helper 后解释", relatedIds: [find("helper")] });
    const beforeRelated = await history();
    await writeFile(join(dir, "main.js"), code.replace("helper(value);", "helper(value) + 1;").replace("value * 2", "value * 3"));
    await rescan();
    const afterRelated = await history();
    assert.equal(afterRelated.fingerprint, beforeRelated.fingerprint);
    assert.equal(afterRelated.turns.at(-1).outdated, true);
    assert.equal(afterRelated.turns.at(-2).outdated, false);
    await post({ question: "验证新的 helper", relatedIds: [find("helper")] });
    assert.equal((await history()).turns.at(-1).outdated, false);
    if (process.env.QUESTIONS_UI_PATH) {
      await writeFile(process.env.QUESTIONS_UI_PATH, JSON.stringify({ base, projectId: local.id, symbolId: sid }));
      for (let i = 0; i < 900; i++) { try { await access(process.env.QUESTIONS_UI_PATH); } catch { break; } await delay(250); }
    }
    assert.equal((await fetch(`${base}/api/projects/${local.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await database.execute("select count(*) as n from symbol_questions")).rows[0].n, 0);
  } finally {
    database?.close();
    if (app && app.exitCode === null) {
      const closed = once(app, "close");
      if (process.platform === "win32") {
        const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        await once(killer, "close");
      } else app.kill();
      await closed;
    }
    api.closeAllConnections(); await new Promise((resolve) => api.close(resolve));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
