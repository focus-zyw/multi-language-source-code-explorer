// RUN_FILE_NOTES_E2E=1; production build required. Own temporary DB/source/server, no AI calls.
// RUN_FILE_NOTES_UI=1 also keeps this fixture alive for manual/browser verification until
// .next/file-notes-ui.done is created (up to five minutes).
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("file notes: API isolation, rescan identity, conflicts and clipboard-sized requests", { skip: process.env.RUN_FILE_NOTES_E2E !== "1", timeout: 420000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-file-notes-"));
  let app;
  const uiDir = process.env.FILE_NOTES_UI_DIR ?? ".next";
  const marker = resolve(uiDir, "file-notes-ui.json"), done = resolve(uiDir, "file-notes-ui.done");
  try {
    const reserve = createServer();
    await new Promise((r) => reserve.listen(0, "127.0.0.1", r)); const port = reserve.address().port; await new Promise((r) => reserve.close(r));
    const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: pathToFileURL(join(temp, "app.db")).href, AI_API_KEY: "", AI_AGENT_ENABLED: "false" };
    delete env.__NEXT_PROCESSED_ENV;
    const push = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "push"], { env, stdio: "pipe", windowsHide: true });
    push.stdout.resume(); push.stderr.resume(); assert.equal((await once(push, "close"))[0], 0);
    let output = "";
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
    app.stdout.on("data", (chunk) => { output += chunk; }); app.stderr.on("data", (chunk) => { output += chunk; });
    const base = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(150); }
    assert.ok(ready, output);
    const json = async (path, options, status = 200) => { const response = await fetch(base + path, options); const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body; };
    const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const source = join(temp, "source"); await mkdir(source);
    await writeFile(join(source, "empty.ts"), "// 没有方法的文件\nconst answer = 42;\n");
    await writeFile(join(source, "other.ts"), "export function other() { return 1; }\n");
    const project = await json("/api/projects/local", post({ action: "import", path: source, name: "文件笔记验证" }), 201);
    const second = await json("/api/projects/local", post({ action: "import", path: source, name: "独立笔记验证" }), 201);
    let tree = await json(`/api/projects/${project.id}/tree`);
    const originalFile = tree.files.find((f) => f.path === "empty.ts");
    const endpoint = (fid, pid = project.id) => `/api/projects/${pid}/files/${fid}`;
    const first = await json(endpoint(originalFile.id)); assert.equal(first.note.version, 0); assert.match(first.file.content, /answer/);
    const input = { path: "empty.ts", revision: 1, version: 0, body: "## 学习笔记\n\n```ts\nconst answer = 42;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| answer | 42 |\n\n$$x^2$$\n\n<script>bad()</script>" };
    const saved = await json(endpoint(originalFile.id), post(input)); assert.equal(saved.body, input.body);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=";
    const mediaInput = { fileId: originalFile.id, path: originalFile.path, revision: 1, src: png };
    const media = await json(`/api/projects/${project.id}/note-media`, post(mediaInput));
    const mediaResponse = await fetch(base + media.url); assert.equal(mediaResponse.status, 200); assert.equal(mediaResponse.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await mediaResponse.arrayBuffer()).toString("base64"), png.split(",")[1]);
    await json(media.url.replace(`/projects/${project.id}/`, `/projects/${second.id}/`), undefined, 404);
    await json(`/api/projects/${project.id}/note-media`, { ...post(mediaInput), headers: { "content-type": "application/json", origin: "https://evil.invalid" } }, 403);
    await json(endpoint(originalFile.id, second.id), undefined, 404);
    await json(endpoint(originalFile.id), post(input), 409);
    await json(endpoint(originalFile.id), { ...post(input), headers: { "content-type": "application/json", origin: "https://evil.invalid" } }, 403);
    await json(endpoint(originalFile.id), post({ ...input, body: "中".repeat(11000) }), 400);
    const appended = await json(endpoint(originalFile.id), post({ ...input, version: 1, body: `${input.body}\n\n追加内容` }));
    assert.equal(appended.version, 2);
    await writeFile(join(source, "empty.ts"), "// 重新扫描后的文件\nconst answer = 43;\n");
    await json(`/api/projects/${project.id}/rescan`, post({}));
    tree = await json(`/api/projects/${project.id}/tree`);
    const file = tree.files.find((f) => f.path === "empty.ts");
    const rescanned = await json(endpoint(file.id)); assert.equal(rescanned.note.body, appended.body); assert.equal(rescanned.revision, 2);
    await json(endpoint(file.id), post({ ...input, version: 2 }), 409);
    if (process.env.RUN_FILE_NOTES_UI === "1") {
      const renderingSample = await readFile("tests/fixtures/file-note-rendering.md", "utf8");
      await json(endpoint(file.id), post({ path: file.path, revision: 2, version: 2, body: renderingSample }));
      await rm(done, { force: true });
      await writeFile(marker, JSON.stringify({ base, projectId: project.id, fileId: file.id, otherFileId: tree.files.find((f) => f.path === "other.ts").id }));
      let finished = false;
      for (let i = 0; i < 600; i++) { try { await access(done); finished = true; break; } catch {} await delay(500); }
      assert.ok(finished, "Browser verification did not finish within five minutes");
    }
  } finally {
    if (app && app.exitCode === null) { app.kill(); await Promise.race([once(app, "close"), delay(5000)]); }
    if (process.env.RUN_FILE_NOTES_UI === "1") { await rm(marker, { force: true }); await rm(done, { force: true }); }
    assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("atlas-file-notes-"));
    await rm(temp, { recursive: true, force: true });
  }
});
