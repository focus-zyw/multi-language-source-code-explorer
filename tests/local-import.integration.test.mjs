import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import nextEnv from "@next/env";

// Requires npm run dev; creates and removes only its own temporary project.
nextEnv.loadEnvConfig(process.cwd(), true);
const base = "http://localhost:3000";

test("local import and rescan preserve identity, replace stale data and roll back failures", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-rescan-中文 "));
  const moved = `${root}-moved`;
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./data/code-atlas.db" });
  let projectId;
  let trigger;
  let uploadedId;
  const post = (url, body = {}, headers = {}) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  async function json(response, expected = 200) {
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  }
  const tree = () => fetch(`${base}/api/projects/${projectId}/tree`).then((response) => json(response));
  const project = () => fetch(`${base}/api/projects/${projectId}`).then((response) => json(response)).then((body) => body.project);
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    const source = "export function original(value) { return Math.abs(value); }";
    await writeFile(path.join(root, "src", "math.js"), source);
    await writeFile(path.join(root, "node_modules", "ignored.js"), "function ignored() {}");
    await writeFile(path.join(root, "README.md"), "ignore this");
    const browsed = await json(await post("/api/projects/local/folders", { path: root }));
    assert.equal(browsed.path, await realpath(root));
    assert.deepEqual(new Set(browsed.folders.map((folder) => folder.name)), new Set(["src", "node_modules"]));
    const child = await json(await post("/api/projects/local/folders", { path: browsed.folders.find((folder) => folder.name === "src").path }));
    assert.deepEqual(child.folders, []);
    assert.equal(child.parent, browsed.path);
    await json(await post("/api/projects/local/folders", { path: root }, { origin: "https://example.org" }), 403);
    await json(await post("/api/projects/local/folders", { path: 123 }), 400);
    const preview = await json(await post("/api/projects/local", { action: "preview", path: root }));
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.sourcePath, await realpath(root));
    assert.deepEqual(preview.samplePaths, ["src/math.js"]);
    assert.equal(preview.skipped["ignored-dir"], 1);
    const imported = await json(await post("/api/projects/local", { action: "import", path: root, name: "Rescan fixture" }), 201);
    projectId = imported.id;
    assert.ok(Number.isInteger(projectId));
    const before = await project();
    const oldTree = await tree();
    assert.equal(before.sourceType, "local");
    assert.equal(before.sourcePath, await realpath(root));
    assert.ok(before.scannedAt);
    assert.equal(oldTree.files[0].path, "src/math.js");
    assert.equal(oldTree.symbols[0].name, "original");
    assert.equal(await readFile(path.join(root, "src", "math.js"), "utf8"), source);

    const oldSymbol = oldTree.symbols[0].id;
    await db.execute({ sql: "insert into symbol_explanations (symbol_id, backend, config_key, content, model, generated_at) values (?, ?, ?, ?, ?, ?)",
      args: [oldSymbol, "api", "local-rescan-test", "old explanation", "fixture", Date.now()] });
    await writeFile(path.join(root, "src", "math.js"), "export function updated(value) { return value + 1; }");
    await writeFile(path.join(root, "src", "added.py"), "def added(value):\n    return value * 3\n");
    trigger = `local_rescan_test_${projectId}`;
    await db.execute(`create trigger ${trigger} before insert on files when NEW.project_id = ${projectId} begin select raise(abort, 'local rescan transaction test'); end`);
    await json(await post(`/api/projects/${projectId}/rescan`), 500);
    assert.deepEqual(await tree(), oldTree, "failed replacement must retain every old ID and row");
    assert.equal((await db.execute({ sql: "select count(*) as n from symbol_explanations where symbol_id = ?", args: [oldSymbol] })).rows[0].n, 1);
    await db.execute(`drop trigger ${trigger}`);
    trigger = undefined;

    const rescanned = await json(await post(`/api/projects/${projectId}/rescan`));
    assert.equal(rescanned.id, projectId);
    assert.equal(rescanned.fileCount, 2);
    const nextTree = await tree();
    assert.deepEqual(new Set(nextTree.symbols.map((symbol) => symbol.name)), new Set(["updated", "added"]));
    assert.ok(!nextTree.symbols.some((symbol) => symbol.id === oldSymbol));
    assert.equal((await project()).createdAt, before.createdAt);
    assert.equal((await project()).name, before.name);
    assert.equal((await db.execute({ sql: "select count(*) as n from symbol_explanations where symbol_id = ?", args: [oldSymbol] })).rows[0].n, 0);
    await rm(path.join(root, "src", "added.py"));
    await json(await post(`/api/projects/${projectId}/rescan`));
    assert.equal((await tree()).files.length, 1);

    // Unreadable/missing sources and unparseable snapshots retain the last successful analysis.
    const stable = await tree();
    await rename(root, moved);
    await json(await post(`/api/projects/${projectId}/rescan`), 422);
    assert.deepEqual(await tree(), stable);
    await rename(moved, root);
    await writeFile(path.join(root, "src", "math.js"), Buffer.from([0, 1, 2]));
    await json(await post(`/api/projects/${projectId}/rescan`), 422);
    assert.deepEqual(await tree(), stable);

    // Removing every source file is a valid empty snapshot, not a failed scan.
    await rm(path.join(root, "src", "math.js"));
    const empty = await json(await post(`/api/projects/${projectId}/rescan`));
    assert.equal(empty.fileCount, 0);
    assert.deepEqual(await tree(), { files: [], symbols: [] });
    await json(await post("/api/projects/local", { action: "import", path: root }), 422);
    await json(await post("/api/projects/local", { action: "preview", path: root }, { origin: "https://example.org" }), 403);
    await json(await post("/api/projects/local", { action: "preview", path: "relative/path" }), 400);

    const upload = new FormData();
    upload.set("mode", "folder");
    upload.set("paths", '["upload.js"]');
    upload.append("files", new Blob(["export function uploaded() {}"]), "upload.js");
    uploadedId = (await json(await fetch(`${base}/api/projects`, { method: "POST", body: upload }), 201)).id;
    await json(await post(`/api/projects/${uploadedId}/rescan`), 409);
  } finally {
    if (trigger) await db.execute(`drop trigger if exists ${trigger}`);
    for (const id of [projectId, uploadedId].filter(Boolean)) await fetch(`${base}/api/projects/${id}`, { method: "DELETE" });
    db.close();
    // These two paths are derived exclusively from this test's mkdtemp result.
    if (existsSync(root)) await rm(root, { recursive: true, force: true });
    if (existsSync(moved)) await rm(moved, { recursive: true, force: true });
  }
});
