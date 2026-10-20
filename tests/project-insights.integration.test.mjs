// RUN_INSIGHTS_E2E=1; production build required. Own temporary DB/source/app, AI disabled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, dirname, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

test("project insights/search isolate projects, preserve dependency confidence, track rescans and report timings", { skip: process.env.RUN_INSIGHTS_E2E !== "1", timeout: process.env.INSIGHTS_UI_PATH ? 360000 : 120000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-insights-"));
  let app;
  try {
    const reserve = createServer(); await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve)); const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: pathToFileURL(join(temp, "app.db")).href, AI_API_KEY: "", AI_AGENT_ENABLED: "false" };
    delete env.__NEXT_PROCESSED_ENV;
    const push = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "push"], { env, stdio: "pipe", windowsHide: true }); push.stdout.resume(); push.stderr.resume(); assert.equal((await once(push, "close"))[0], 0);
    let diagnostics = "";
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
    app.stdout.on("data", (chunk) => { diagnostics += chunk; }); app.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const base = `http://localhost:${port}`;
    let ready = false; for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(150); }
    assert.ok(ready, diagnostics);
    const json = async (url, options, status = 200) => { const response = await fetch(base + url, options); const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
    const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const source = join(temp, "source"); await mkdir(source); await mkdir(join(source, "api"));
    await writeFile(join(source, "a.ts"), 'import { b } from "./api/b";\n/** @deprecated use another entry */\nexport function a(flag: boolean) { if (flag) return b(); return 0; }\nexport function many() { a(true); a(false); }\nclass BaseService {}\nexport class Store extends BaseService {}\n');
    await writeFile(join(source, "api/b.ts"), 'import { a } from "../a";\nexport function b() { return a(false); }\n');
    await writeFile(join(source, "boundary.ts"), 'import { missing } from "./absent";\nimport fs from "node:fs";\nexport function boundary() { missing(); fs.readFileSync("x"); }\n');
    await writeFile(join(source, "Controller.java"), '@RequestMapping("/v1") class Controller { @GetMapping("/items") public String items() { return "ok"; } }');
    await writeFile(join(source, "controller.ts"), '@Controller("api")\nexport class Controller { @Get("items") items() { return 1; } }');
    await writeFile(join(source, "routes.py"), '@router.get("/items")\ndef items():\n  return 1\n');
    await writeFile(join(source, "config.json"), '{"debug":true}');
    await writeFile(join(source, "bulk.ts"), Array.from({ length: 45 }, (_, i) => `export function bulk${i}() { return ${i}; }`).join("\n"));
    const imported = await json("/api/projects/local", post({ action: "import", path: source, name: "静态架构学习示例" }), 201);
    const id = imported.id; assert.ok(id);
    const other = join(temp, "other"); await mkdir(other); await writeFile(join(other, "secret.ts"), "export function isolatedSecret() { return 1; }");
    const second = await json("/api/projects/local", post({ action: "import", path: other }), 201);
    const tree = await json(`/api/projects/${id}/tree`);
    const foo = tree.symbols.find((symbol) => symbol.name === "a");
    const learning = await json(`/api/projects/${id}/learning?symbolId=${foo.id}&list=1`);
    assert.equal(learning.revision, 1); assert.equal(learning.selected.name, "a");
    const bookmark = await json(`/api/projects/${id}/learning`, post({ action: "bookmark", symbolId: foo.id, revision: 1 }));
    const noteInput = { action: "create", id: randomUUID(), symbolId: foo.id, revision: 1, quote: "return b()", content: { title: "a 的学习笔记", body: "先判断 flag，再调用 b。", tags: ["调用链"], status: "reading" } };
    const note = await json(`/api/projects/${id}/notes`, post(noteInput));
    assert.equal((await json(`/api/projects/${id}/notes`, post(noteInput))).id, note.id);
    assert.equal((await json(`/api/projects/${second.id}/notes`)).total, 0);
    await json(`/api/projects/${second.id}/notes?noteId=${note.id}`, undefined, 404);
    await json(`/api/projects/${id}/notes`, post({ action: "update", id: note.id, version: 9, content: noteInput.content }), 409);
    await json(`/api/projects/${id}/notes`, { ...post(noteInput), headers: { "content-type": "application/json", origin: "https://evil.invalid" } }, 403);
    const related = await json(`/api/projects/${id}/notes`, post({ action: "create", id: randomUUID(), content: { ...noteInput.content, title: "b 的学习前置知识" } }));
    const linkInput = { action: "link", source: note.id, target: related.id, label: "建议先读" };
    await json(`/api/projects/${id}/notes`, post(linkInput));
    assert.equal((await json(`/api/projects/${id}/notes?links=${related.id}`)).incoming[0].id, note.id);
    await json(`/api/projects/${second.id}/notes`, post(linkInput), 404);
    const plainPack = await json(`/api/projects/${id}/notes/transfer`);
    assert.ok(plainPack.notes.every((n) => n.anchor === null && n.quote === null));
    const pack = await json(`/api/projects/${id}/notes/transfer?source=1`);
    const transfer = `/api/projects/${second.id}/notes/transfer`;
    let preview = await json(transfer, post({ action: "preview", package: pack }));
    assert.equal(preview.added, 2); assert.equal(preview.linksAdded, 1);
    await json(transfer, post({ action: "import", package: pack, token: "wrong" }), 409);
    await json(transfer, post({ action: "import", package: pack, token: preview.token }));
    const copiedNotes = await json(`/api/projects/${second.id}/notes`);
    const copied = copiedNotes.items.find((n) => n.title === note.title);
    assert.equal(copied.anchor, null); assert.equal(copied.resolution, null); assert.equal(copied.quoteStartLine, null);
    assert.equal(copied.importedAnchor.path, "a.ts");
    const copiedLinks = await json(`/api/projects/${second.id}/notes?links=${copied.id}`);
    assert.equal(copiedLinks.outgoing.length, 1); assert.notEqual(copiedLinks.outgoing[0].id, related.id);
    preview = await json(transfer, post({ action: "preview", package: pack }));
    assert.equal(preview.added, 0); assert.equal(preview.linksAdded, 0);
    await json(transfer, post({ action: "import", package: pack, token: preview.token }));
    await json(transfer, post({ action: "preview", package: { ...pack, schemaVersion: 9 } }), 400);
    await json(transfer, { ...post({ action: "preview", package: pack }), headers: { "content-type": "application/json", origin: "https://evil.invalid" } }, 403);
    await json(transfer, post({ action: "preview", padding: "x".repeat(10 * 1024 * 1024 + 1024) }), 413);
    const markdown = await fetch(`${base}/api/projects/${id}/notes/transfer?format=markdown`);
    assert.equal(markdown.status, 200); assert.match(markdown.headers.get("content-disposition"), /attachment/);
    assert.match(await markdown.text(), /a 的学习笔记/);
    assert.equal((await json(`/api/projects/${id}/learning`, post({ action: "bookmark", symbolId: foo.id, revision: 1 }))).id, bookmark.id);
    assert.equal((await json(`/api/projects/${second.id}/learning?list=1`)).bookmarks.length, 0);
    await json(`/api/projects/${second.id}/learning?symbolId=${foo.id}`, undefined, 404);
    await json(`/api/projects/${id}/learning`, { ...post({ action: "bookmark", symbolId: foo.id, revision: 1 }), headers: { "content-type": "application/json", origin: "https://untrusted.invalid" } }, 403);
    let insights = await json(`/api/projects/${id}/insights`);
    assert.ok(insights.dependencies.cycles.some((group) => group.length === 2));
    assert.ok(insights.dependencies.boundaries.some((item) => item.kind === "unresolved"));
    assert.ok(insights.dependencies.boundaries.some((item) => item.kind === "external"));
    assert.ok(insights.dependencies.files.every((file) => !file.path.includes("secret")));
    assert.ok(insights.dependencies.edges.every((edge) => insights.dependencies.files.some((file) => file.id === edge.source) && insights.dependencies.files.some((file) => file.id === edge.target)));
    assert.equal(insights.learning.referenced.find((item) => item.name === "a").exactCallers, 2); // many() repeated calls count once, b() once.
    assert.ok(insights.learning.complex.every((item) => !item.path.endsWith(".json")));
    for (const value of Object.values(insights.scan)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(insights.scan.totalMs >= insights.scan.parseMs);
    assert.equal((await json(`/api/projects/${id}/search?deprecated=1`)).items[0].name, "a");
    assert.equal((await json(`/api/projects/${id}/search?base=BaseService`)).items[0].name, "Store");
    assert.ok((await json(`/api/projects/${id}/search?decorator=Get&kind=method`)).total >= 2);
    const bulk = await json(`/api/projects/${id}/search?q=bulk`); assert.equal(bulk.total, 45); assert.equal(bulk.items.length, 40);
    assert.equal((await json(`/api/projects/${id}/search?q=bulk&page=1`)).items.length, 5);
    const metricSearch = await json(`/api/projects/${id}/search?scope=source&minCc=2&minExactCallers=2&sort=complexity&order=desc`);
    assert.deepEqual(metricSearch.items.map((item) => item.name), ["a"]);
    assert.equal(metricSearch.items[0].exactCallers, 2);
    assert.equal(metricSearch.items[0].params, 1);
    assert.ok((await json(`/api/projects/${id}/search?sort=params&order=desc`)).items.every((item) => ["function", "method"].includes(item.kind)));
    assert.equal((await json(`/api/projects/${id}/search?minParams=0&maxParams=0&q=bulk`)).total, 45);
    await json(`/api/projects/${id}/search?minCc=10&maxCc=1`, undefined, 400);
    await json(`/api/projects/${id}/search?sort=unknown`, undefined, 400);
    assert.equal((await json(`/api/projects/${id}/search?q=isolatedSecret`)).total, 0);
    assert.equal((await json(`/api/projects/${second.id}/search?q=isolatedSecret`)).total, 1);
    const entries = await json(`/api/projects/${id}/entries`);
    assert.ok(entries.groups.flatMap((group) => group.entries).some((entry) => entry.reason.includes("/v1/items")));
    assert.ok(entries.groups.flatMap((group) => group.entries).some((entry) => entry.reason.includes("/api/items")));
    for (const endpoint of ["insights", "search"]) {
      await json(`/api/projects/nope/${endpoint}`, undefined, 400); await json(`/api/projects/999999999/${endpoint}`, undefined, 404);
    }
    await json(`/api/projects/${id}/search?kind=invalid`, undefined, 400);
    await json(`/api/projects/${id}/search?q=${"x".repeat(201)}`, undefined, 400);
    await writeFile(join(source, "a.ts"), "export function a() { return 0; }\n");
    await json(`/api/projects/${id}/rescan`, post({}));
    const rescanned = await json(`/api/projects/${id}/learning?list=1`);
    assert.equal(rescanned.revision, 2); assert.equal(rescanned.bookmarks[0].id, bookmark.id);
    assert.equal(rescanned.bookmarks[0].freshness, "changed");
    const oldNote = await json(`/api/projects/${id}/notes?noteId=${note.id}`);
    assert.equal(oldNote.body, noteInput.content.body); assert.equal(oldNote.resolution.freshness, "changed"); assert.equal(oldNote.quoteStartLine, null);
    const trashedNote = await json(`/api/projects/${id}/notes`, post({ action: "trash", id: note.id, version: 1 }));
    assert.equal((await json(`/api/projects/${id}/notes?trash=1`)).total, 1);
    assert.equal((await json(`/api/projects/${id}/notes`, post({ action: "restore", id: note.id, version: trashedNote.version }))).deletedAt, null);
    await json(`/api/projects/${id}/learning`, post({ action: "bookmark", symbolId: rescanned.bookmarks[0].symbolId, revision: 1 }), 409);
    const restored = await json(`/api/projects/${id}/learning`, post({ action: "resolve", anchors: [learning.selected] }));
    assert.equal(restored.anchors[0].symbolId, rescanned.bookmarks[0].symbolId);
    insights = await json(`/api/projects/${id}/insights`); assert.deepEqual(insights.dependencies.cycles, []);
    assert.equal((await json(`/api/projects/${id}/search?deprecated=1`)).total, 0);
    assert.equal((await json(`/api/projects/${id}/search?minCc=2&minExactCallers=2`)).total, 0);
    const nextTree = await json(`/api/projects/${id}/tree`); assert.notEqual(tree.symbols.find((symbol) => symbol.name === "a").id, nextTree.symbols.find((symbol) => symbol.name === "a").id);
    // Restore the cycle for optional browser inspection, still in this temporary DB.
    await writeFile(join(source, "a.ts"), 'import { b } from "./api/b";\n/** @deprecated use another entry */\nexport function a(flag: boolean) { if (flag) return b(); return 0; }\nexport function many() { a(true); a(false); }\n');
    await json(`/api/projects/${id}/rescan`, post({}));
    console.log("Scan timing sample (ms):", JSON.stringify((await json(`/api/projects/${id}/insights`)).scan));
    if (process.env.INSIGHTS_UI_PATH) {
      await writeFile(process.env.INSIGHTS_UI_PATH, JSON.stringify({ base, projectId: id }));
      for (let i = 0; i < 1000; i++) { try { await access(process.env.INSIGHTS_UI_PATH); } catch { break; } await delay(250); }
    }
  } finally {
    if (app && app.exitCode === null) {
      const closed = once(app, "close");
      if (process.platform === "win32") { const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await once(killer, "close"); } else app.kill();
      await closed;
    }
    assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("atlas-insights-"));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
