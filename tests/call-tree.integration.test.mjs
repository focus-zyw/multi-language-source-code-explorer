import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Requires the local dev server; only the fixture project is modified/deleted.
const base = "http://localhost:3000";
test("call-tree API paginates call sites, reverses callers and isolates project IDs", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-call-tree-"));
  let projectId;
  const json = async (response, expected = 200) => {
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body;
  };
  try {
    await writeFile(path.join(directory, "app.js"), `
export function leaf(value) { return value + 1; }
export function recurse(value) { return value ? recurse(value - 1) : leaf(value); }
export function entry(value) {
${Array.from({ length: 14 }, (_, index) => `  leaf(value + ${index});`).join("\n")}
  recurse(value);
  console.log(value);
  missing(value);
}
`);
    const imported = await json(await fetch(`${base}/api/projects/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "import", path: directory, name: "Call tree test fixture" }) }), 201);
    projectId = imported.id;
    const tree = await json(await fetch(`${base}/api/projects/${projectId}/tree`));
    const find = (name) => { const item = tree.symbols.find((symbol) => symbol.name === name); assert.ok(item, name); return item.id; };
    const entry = find("entry"), leaf = find("leaf"), recurse = find("recurse");
    const url = (id, query = "") => `${base}/api/projects/${projectId}/symbols/${id}/calls${query}`;
    const first = await json(await fetch(url(entry)));
    assert.equal(first.branches.length, 10);
    assert.equal(first.nextOffset, 10);
    assert.equal(first.symbol.id, entry);
    assert.equal(first.direction, "outgoing");
    assert.equal("content" in first.symbol, false);
    const second = await json(await fetch(url(entry, "?offset=10")));
    assert.equal(second.nextOffset, null);
    const calls = [...first.branches, ...second.branches];
    assert.equal(calls.length, 17);
    assert.equal(new Set(calls.map((call) => call.refId)).size, 17);
    assert.equal(calls.filter((call) => call.targets.some((target) => target.symbol.id === leaf)).length, 14);
    assert.ok(calls.some((call) => call.resolution === "external" && call.targets.length === 0));
    assert.ok(calls.some((call) => call.resolution === "unresolved" && call.targets.length === 0));
    const projectOnly = await json(await fetch(url(entry, "?scope=project")));
    const projectRest = await json(await fetch(url(entry, "?scope=project&offset=10")));
    assert.equal([...projectOnly.branches, ...projectRest.branches].length, 15);
    assert.ok([...projectOnly.branches, ...projectRest.branches].every((call) => call.targets.length > 0));
    const recursive = await json(await fetch(url(recurse)));
    assert.ok(recursive.branches.some((call) => call.targets.some((target) => target.symbol.id === recurse)));
    const incoming = await json(await fetch(url(leaf, "?direction=incoming")));
    const rest = await json(await fetch(url(leaf, "?direction=incoming&offset=10")));
    assert.equal([...incoming.branches, ...rest.branches].length, 15);
    assert.deepEqual(new Set([...incoming.branches, ...rest.branches].flatMap((call) => call.targets.map((target) => target.symbol.id))), new Set([entry, recurse]));
    assert.deepEqual((await json(await fetch(url(leaf)))).branches, []);
    await json(await fetch(url(entry, "?direction=invalid")), 400);
    await json(await fetch(url(entry, "?scope=invalid")), 400);
    await json(await fetch(url(entry, "?offset=-1")), 400);
    await json(await fetch(url(entry, "?offset=1.5")), 400);
    await json(await fetch(`${base}/api/projects/999999999/symbols/${entry}/calls`), 404);
    await json(await fetch(url(999999999)), 404);
    await json(await fetch(`${base}/api/projects/nope/symbols/${entry}/calls`), 400);
  } finally {
    if (projectId) assert.equal((await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" })).status, 200);
    await rm(directory, { recursive: true, force: true });
  }
});
