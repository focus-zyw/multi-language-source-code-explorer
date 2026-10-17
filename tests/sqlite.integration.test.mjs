import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import nextEnv from "@next/env";

// Run against a local development server: node --test tests/sqlite.integration.test.mjs
nextEnv.loadEnvConfig(process.cwd(), true);
const base = "http://localhost:3000";
const fixtureRoot = new URL("./fixtures/", import.meta.url);

function fixtureFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? fixtureFiles(path) : [path];
  });
}

test("SQLite persists imports, joins references, allocates unique IDs and cascades deletion", async () => {
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(fixtureRoot);
  const db = createClient({ url: process.env.DATABASE_URL ?? "file:./data/code-atlas.db" });
  const created = new Set();
  async function json(path, options) {
    const response = await fetch(`${base}${path}`, options);
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  }
  async function importProject() {
    const form = new FormData();
    form.set("mode", "folder");
    form.set("name", "SQLite integration verification");
    const paths = [];
    for (const path of fixtureFiles(root)) {
      paths.push(relative(root, path).replaceAll("\\", "/"));
      form.append("files", new Blob([readFileSync(path)]), paths.at(-1));
    }
    // Exercise several insert chunks, rather than only tiny inserts.
    const bulk = Array.from({ length: 90 }, (_, i) => `export function example${i}(value) { return Math.abs(value); }`).join("\n");
    paths.push("bulk.js");
    form.append("files", new Blob([bulk]), "bulk.js");
    form.set("paths", JSON.stringify(paths));
    const result = await json("/api/projects", { method: "POST", body: form });
    created.add(result.id);
    assert.ok(result.symbolCount > 90);
    return result.id;
  }
  async function deleteProject(id) {
    await json(`/api/projects/${id}`, { method: "DELETE" });
    for (const table of ["files", "symbols", "refs", "ref_targets", "test_links"]) {
      const result = await db.execute({ sql: `select count(*) as n from ${table} where project_id = ?`, args: [id] });
      assert.equal(Number(result.rows[0].n), 0, `${table} must cascade`);
    }
    created.delete(id);
  }
  try {
    assert.equal((await json("/api/health")).ok, true);
    const first = await importProject();
    const tree = await json(`/api/projects/${first}/tree`);
    assert.ok(tree.symbols.length > 90);
    assert.ok(tree.files.some((file) => file.isTest === true));
    let foundRefs = false;
    let foundTests = false;
    for (const symbol of tree.symbols.filter((s) => !s.name.startsWith("example")).slice(0, 30)) {
      const detail = await json(`/api/projects/${first}/symbols/${symbol.id}`);
      assert.ok(Array.isArray(detail.symbol.params));
      assert.equal(typeof detail.symbol.isAsync, "boolean");
      foundRefs ||= detail.outgoing.some((ref) => ref.targets.length > 0);
      foundTests ||= detail.tests.length > 0;
    }
    assert.ok(foundRefs, "cross-file reference joins must work");
    assert.ok(foundTests, "test association joins must work");
    const method = tree.symbols.find((s) => s.kind === "function");
    assert.ok((await json(`/api/projects/${first}/symbols/${method.id}/analysis`)).flow);
    const { project } = await json(`/api/projects/${first}`);
    assert.ok(Number.isFinite(Date.parse(project.createdAt)));
    assert.ok(project.languages.python > 0);
    assert.ok((await db.execute({ sql: "select count(*) as n from files where project_id = ?", args: [first] })).rows[0].n > 0);
    const second = await importProject();
    const secondTree = await json(`/api/projects/${second}/tree`);
    assert.ok(Math.min(...secondTree.symbols.map((s) => s.id)) > Math.max(...tree.symbols.map((s) => s.id)));
    await deleteProject(first);
    assert.equal((await json(`/api/projects/${second}/tree`)).symbols.length, secondTree.symbols.length);
    await deleteProject(second);
    const third = await importProject();
    const thirdTree = await json(`/api/projects/${third}/tree`);
    assert.ok(Math.min(...thirdTree.symbols.map((s) => s.id)) > Math.max(...secondTree.symbols.map((s) => s.id)));
    await deleteProject(third);
  } finally {
    for (const id of created) await fetch(`${base}/api/projects/${id}`, { method: "DELETE" });
    db.close();
  }
});
