// Requires a production build. Creates its own database, source project and runner fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

test("isolated test runner API: consent, origin, ownership, real execution, stop and fresh coverage", { skip: process.env.RUN_TEST_RUNNER_E2E !== "1", timeout: 300000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-test-api-"));
  let app;
  try {
    const reserve = createServer(); await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
    const port = reserve.address().port; await new Promise((r) => reserve.close(r));
    const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: pathToFileURL(join(temp, "app.db")).href, CODE_ATLAS_TEST_EXECUTION: "true", AI_AGENT_ENABLED: "false" };
    delete env.__NEXT_PROCESSED_ENV;
    const push = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "push"], { env, stdio: "pipe", windowsHide: true }); push.stdout.resume(); push.stderr.resume(); assert.equal((await once(push, "close"))[0], 0);
    let appLog = "";
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
    app.stdout.on("data", (s) => { appLog += s; }); app.stderr.on("data", (s) => { appLog += s; });
    const base = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(200); }
    assert.ok(ready, appLog);
    const root = join(temp, "source"); await mkdir(root);
    const content = "export function double(value) {\n  return value * 2;\n}\n";
    await writeFile(join(root, "main.mjs"), content);
    await writeFile(join(root, "check.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert/strict"; import {double} from "./main.mjs"; test("double", () => assert.equal(double(3), 6));');
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test check.test.mjs" } }));
    const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const imported = await (await post(`${base}/api/projects/local`, { action: "import", path: root })).json(); assert.ok(imported.id);
    const tree = await (await fetch(`${base}/api/projects/${imported.id}/tree`)).json();
    const sid = tree.symbols.find((s) => s.name === "double" && s.kind === "function").id;
    const endpoint = `${base}/api/projects/${imported.id}/test-runs`;
    const state = async (symbol = sid) => { const reply = await fetch(`${endpoint}?symbolId=${symbol}`, { headers: { "content-type": "application/json" } }); assert.equal(reply.status, 200, await reply.clone().text()); return reply.json(); };
    const wait = async () => { for (let i = 0; i < 100; i++) { const s = await state(); if (s.run?.finishedAt) return s.run; await delay(100); } throw Error("run did not complete"); };
    const command = "node --test check.test.mjs";
    const request = { action: "run", profileId: "test", command, coverage: false, confirmExecution: true };
    assert.equal((await state()).profiles[0].command, command);
    assert.equal((await post(endpoint, { ...request, confirmExecution: false })).status, 400);
    assert.equal((await post(endpoint, request, { origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await post(endpoint, { ...request, command: "changed" })).status, 409);
    assert.equal((await fetch(`${endpoint}?symbolId=99999999`, { headers: { "content-type": "application/json" } })).status, 404);
    assert.equal((await post(endpoint, request)).status, 202);
    assert.equal((await wait()).status, "passed");
    await writeFile(join(root, "check.test.mjs"), "setInterval(() => {}, 1000);");
    const running = await (await post(endpoint, request)).json();
    assert.equal((await post(endpoint, request)).status, 409);
    assert.equal((await post(endpoint, { action: "stop", runId: running.id })).status, 200);
    assert.equal((await wait()).status, "cancelled");
    // A deterministic LCOV-emitting adapter fixture, not a real Jest installation.
    await mkdir(join(root, "node_modules/jest/bin"), { recursive: true });
    await writeFile(join(root, "node_modules/jest/bin/jest.js"), 'const fs = require("node:fs"), path = require("node:path"); const dir = process.argv.find(a => a.startsWith("--coverageDirectory=")).slice("--coverageDirectory=".length); fs.writeFileSync(path.join(dir,"lcov.info"), "SF:main.mjs\\nDA:2,1\\nend_of_record\\n"); console.log("PASS fixture");');
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test check.test.mjs", "test:coverage": "jest" } }));
    const covRequest = { ...request, profileId: "test:coverage", command: "jest", coverage: true };
    assert.equal((await post(endpoint, covRequest)).status, 202);
    const covered = await wait(); assert.equal(covered.status, "passed"); assert.ok(covered.coverage[0], JSON.stringify(covered)); assert.equal(covered.coverage[0].lines[0].hits, 1);
    await writeFile(join(root, "main.mjs"), "// changed\n" + content);
    assert.deepEqual((await state()).run.coverage, []);
    await writeFile(join(root, "main.mjs"), content);
    if (process.env.TEST_RUNNER_UI_PATH) {
      await writeFile(join(root, "check.test.mjs"), 'import {test} from "node:test"; test("UI fixture", async () => { await new Promise(r => setTimeout(r, 2500)); });');
      await writeFile(process.env.TEST_RUNNER_UI_PATH, JSON.stringify({ base, projectId: imported.id, symbolId: sid }));
      for (let i = 0; i < 800; i++) { try { await access(process.env.TEST_RUNNER_UI_PATH); } catch { break; } await delay(250); }
    }
    // Deleting a project must also terminate a task that would otherwise become inaccessible.
    await writeFile(join(root, "check.test.mjs"), 'import {writeFileSync} from "node:fs"; console.log("delete-fixture-ready"); setTimeout(() => writeFileSync("should-not-exist.txt", "ran after delete"), 1800); setInterval(() => {}, 1000);');
    assert.equal((await post(endpoint, request)).status, 202);
    for (let i = 0; i < 50; i++) { if ((await state()).run.output.includes("delete-fixture-ready")) break; await delay(50); }
    assert.equal((await fetch(`${base}/api/projects/${imported.id}`, { method: "DELETE" })).status, 200);
    await delay(2000);
    await assert.rejects(access(join(root, "should-not-exist.txt")));
  } finally {
    if (app) { app.kill(); await once(app, "close"); }
    await rm(temp, { recursive: true, force: true });
  }
});
