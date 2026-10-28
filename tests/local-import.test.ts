import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectLocalDirectory } from "../src/lib/ingest/local.ts";
import { readLocalBody } from "../src/lib/ingest/local-request.ts";
import { listLocalFolders } from "../src/lib/ingest/folders.ts";

test("folder picker lists real subfolders with absolute paths, excluding files and junctions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-browse-"));
  try {
    await mkdir(path.join(root, "子目录 with spaces"));
    await writeFile(path.join(root, "not-a-folder.js"), "export function ignored() {}");
    const result = await listLocalFolders(root);
    assert.equal(result.path, await realpath(root));
    assert.equal(result.parent, path.dirname(await realpath(root)));
    assert.deepEqual(result.folders, [{ name: "子目录 with spaces", path: path.join(await realpath(root), "子目录 with spaces") }]);
    assert.ok(result.shortcuts.some((shortcut) => shortcut.path === process.cwd()));
    assert.equal(result.truncated, false);
    const child = await listLocalFolders(result.folders[0].path);
    assert.equal(child.parent, result.path);
    assert.deepEqual(child.folders, []);
    await assert.rejects(listLocalFolders("relative/path"), /绝对路径/);
    await assert.rejects(listLocalFolders(path.join(root, "missing")), /不存在或无法访问/);
    await assert.rejects(listLocalFolders(path.join(root, "not-a-folder.js")), /不是文件夹/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local preview preserves paths, filters entries, and reads nothing into the snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-local-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "src", "中文.ts"), "export function hello() { return 1; }");
    await writeFile(path.join(root, "node_modules", "ignored.js"), "throw Error('must not execute');");
    await writeFile(path.join(root, "notes.md"), "ignored");
    await writeFile(path.join(root, "types.d.ts"), "declare let value: string;");
    await writeFile(path.join(root, "big.js"), Buffer.alloc(1024 * 1024 + 1));
    const preview = await collectLocalDirectory(`"${root}"`, true);
    assert.equal(preview.sourcePath, await realpath(root));
    assert.equal(preview.fileCount, 1);
    assert.deepEqual(preview.files, []);
    assert.deepEqual(preview.samplePaths, ["src/中文.ts"]);
    assert.deepEqual(new Set(preview.skipped.map((item) => item.reason)), new Set(["ignored-dir", "unsupported-language", "declaration-file", "too-large"]));
    const collected = await collectLocalDirectory(root);
    assert.equal(collected.files[0].path, "src/中文.ts");
    assert.equal(collected.files[0].data.toString(), "export function hello() { return 1; }");
    assert.equal(collected.totalBytes, Buffer.byteLength(collected.files[0].data));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local collection skips nested directory symlinks and Windows junctions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-link-"));
  const outside = await mkdtemp(path.join(tmpdir(), "atlas-outside-"));
  try {
    await writeFile(path.join(outside, "private.js"), "function outside() {}");
    try { await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlinks unavailable on this host"); return; }
      throw error;
    }
    const result = await collectLocalDirectory(root);
    assert.equal(result.fileCount, 0);
    assert.deepEqual(result.skipped, [{ path: "linked", reason: "symlink" }]);
    assert.deepEqual((await listLocalFolders(root)).folders, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("local collection rejects relative, missing, file and drive-root paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-invalid-"));
  try {
    await writeFile(path.join(root, "file.js"), "function noop() {}");
    await assert.rejects(collectLocalDirectory("relative/path"), /绝对路径/);
    await assert.rejects(collectLocalDirectory(root + "\0"), /有效/);
    await assert.rejects(collectLocalDirectory(path.join(root, "missing")), /不存在或无法访问/);
    await assert.rejects(collectLocalDirectory(path.join(root, "file.js")), /不是文件夹/);
    await assert.rejects(collectLocalDirectory(path.parse(root).root), /磁盘根目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local requests require localhost, same origin and a bounded JSON object", async () => {
  const request = (url: string, body: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.deepEqual(await readLocalBody(request("http://localhost:3000/api/projects/local", '{"path":"test"}')), { path: "test" });
  // 本机访问同一端口时，localhost / 127.0.0.1 / [::1] 互为别名，不能因地址写法不同而拒绝。
  assert.deepEqual(await readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { host: "127.0.0.1:3000" })), {});
  assert.deepEqual(await readLocalBody(request("http://127.0.0.1:3000/api/projects/local", "{}", { host: "localhost:3000" })), {});
  assert.deepEqual(await readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { host: "[::1]:3000", origin: "http://127.0.0.1:3000" })), {});
  await assert.rejects(readLocalBody(request("http://example.org/api/projects/local", "{}")), /本机访问/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { host: "example.org:3000" })), /请求地址不匹配/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { host: "localhost:4000" })), /请求地址不匹配/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { host: "localhost:3000/api" })), /请求地址不匹配/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { origin: "https://example.org" })), /跨站/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { origin: "http://localhost:4000" })), /跨站/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { "sec-fetch-site": "cross-site" })), /跨站/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "{}", { "content-type": "text/plain" })), /application\/json/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "null")), /JSON 对象/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "[1]")), /JSON 对象/);
  await assert.rejects(readLocalBody(request("http://localhost:3000/api/projects/local", "x".repeat(9000))), /内容过长/);
});
