import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), true);
const base = "http://localhost:3000";

// Opt in because this exercises the actual logged-in Agent and consumes its usage.
test("real Agent explanation, isolated cache, validation and cascade", { skip: process.env.RUN_AGENT_E2E !== "1", timeout: 630_000 }, async () => {
  let projectId;
  let symbolId;
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./data/code-atlas.db" });
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  try {
    const form = new FormData();
    form.set("name", "Agent integration verification");
    form.set("mode", "folder");
    form.set("paths", '["math.js"]');
    form.append("files", new Blob(["export function double(value) { return value * 2; }"]), "math.js");
    const imported = await fetch(`${base}/api/projects`, { method: "POST", body: form });
    assert.equal(imported.status, 201);
    projectId = (await imported.json()).id;
    const tree = await (await fetch(`${base}/api/projects/${projectId}/tree`)).json();
    symbolId = tree.symbols[0].id;
    const path = `/api/projects/${projectId}/symbols/${symbolId}/explain`;
    console.log(`Review page: ${base}/p/${projectId}?s=${symbolId}&ai=agent`);
    assert.equal((await post(path, { backend: "other" })).status, 400);
    assert.equal((await post(path, null)).status, 400);
    assert.equal((await post(path, { backend: "agent", force: "true" })).status, 400);
    assert.equal((await post(path, { backend: "agent" }, { origin: "https://example.org" })).status, 403);
    const generated = await post(path, { backend: "agent" });
    const result = await generated.json();
    assert.equal(generated.status, 200, JSON.stringify(result));
    assert.equal(result.backend, "agent");
    assert.equal(result.cached, false);
    assert.ok(result.explanation.length > 50);
    const cached = await (await post(path, { backend: "agent" })).json();
    assert.equal(cached.cached, true);
    assert.equal(cached.explanation, result.explanation);
    const detail = await (await fetch(`${base}/api/projects/${projectId}/symbols/${symbolId}`)).json();
    assert.equal(detail.ai.explanations.agent.explanation, result.explanation);
    assert.equal(detail.ai.explanations.api, undefined);
    if (!detail.ai.backends.api.available) {
      const apiResult = await post(path, { backend: "api" });
      assert.equal(apiResult.status, 503, "API must not return the Agent cache");
    }
    const stored = await db.execute({ sql: "select backend, content from symbol_explanations where symbol_id = ?", args: [symbolId] });
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].backend, "agent");
  } finally {
    if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" });
    if (symbolId) {
      const remaining = await db.execute({ sql: "select count(*) as n from symbol_explanations where symbol_id = ?", args: [symbolId] });
      assert.equal(Number(remaining.rows[0].n), 0);
    }
    db.close();
  }
});
