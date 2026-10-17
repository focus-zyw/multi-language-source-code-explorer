import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const base = "http://localhost:3000";
test("project entry overview detects persisted entry symbols and connects to call exploration", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-project-entries-"));
  let projectId;
  const json = async (response, expected = 200) => { const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body; };
  try {
    await mkdir(path.join(directory, "src/app/api/items"), { recursive: true });
    await writeFile(path.join(directory, "src/app/page.tsx"), "function helper() { return 1; }\nexport default function Home() { return helper(); }");
    await writeFile(path.join(directory, "src/app/api/items/route.ts"), "function helper() { return 2; }\nexport function GET() { return helper(); }");
    const imported = await json(await fetch(`${base}/api/projects/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "import", path: directory, name: "Project entries fixture" }) }), 201);
    projectId = imported.id;
    const overview = await json(await fetch(`${base}/api/projects/${projectId}/entries`));
    assert.equal(overview.entryCount, 2);
    assert.deepEqual(overview.groups.map((group) => group.id), ["pages", "api"]);
    const entries = overview.groups.flatMap((group) => group.entries);
    assert.deepEqual(entries.map((entry) => entry.symbol.name), ["Home", "GET"]);
    for (const entry of entries) {
      assert.equal("content" in entry.symbol, false);
      assert.ok(entry.reason);
      const calls = await json(await fetch(`${base}/api/projects/${projectId}/symbols/${entry.symbol.id}/calls?scope=project`));
      assert.equal(calls.branches[0].targets[0].symbol.name, "helper");
    }
    await json(await fetch(`${base}/api/projects/999999999/entries`), 404);
    await json(await fetch(`${base}/api/projects/nope/entries`), 400);
  } finally {
    if (projectId) assert.equal((await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" })).status, 200);
    await rm(directory, { recursive: true, force: true });
  }
});
