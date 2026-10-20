import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { cancelRun, discoverRunners, hashSource, latestRun, parseLcov, projectRoot, safeFile, scriptArguments, startRun } from "../src/lib/test-runner.ts";
import type { TestRunResult } from "../src/lib/test-run-types.ts";

async function finish(run: TestRunResult) {
  for (let i = 0; i < 200 && !run.finishedAt; i++) await delay(30);
  assert.ok(run.finishedAt, "runner did not finish");
  return run;
}

test("runner discovery preserves simple test argv and refuses shell/watch scripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-discover-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: 'node --test "tests/a b.mjs"', "test:bad": "node --test && echo bad", "test:env": "SECRET=x node --test", "test:watch": "vitest watch", "test:unit": "vitest run" } }));
    await mkdir(path.join(root, "node_modules/vitest"), { recursive: true });
    await writeFile(path.join(root, "node_modules/vitest/vitest.mjs"), "");
    const profiles = await discoverRunners(root);
    assert.deepEqual(profiles.map((p) => p.id), ["test", "test:unit"]);
    assert.deepEqual(profiles[0].args, ["--test", "tests/a b.mjs"]);
    assert.equal(scriptArguments("node --test; rm -rf x"), null);
    assert.equal(scriptArguments('node --test "broken'), null);
    assert.equal(await projectRoot(root), await import("node:fs/promises").then((fs) => fs.realpath(root)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("LCOV merges records, retains misses and rejects outside paths", () => {
  const root = path.resolve("fixture");
  const report = `SF:src/a.ts\nDA:2,1\nDA:3,0\nend_of_record\nSF:src/a.ts\nDA:2,2\nend_of_record\nSF:../outside.ts\nDA:1,8\nend_of_record\nSF:${path.join(root, "src/b.ts")}\nDA:4,1\nend_of_record`;
  assert.deepEqual(parseLcov(report, root), [{ path: "src/a.ts", lines: [{ line: 2, hits: 3 }, { line: 3, hits: 0 }] }, { path: "src/b.ts", lines: [{ line: 4, hits: 1 }] }]);
});

test("safe reads reject traversal, oversized files and linked directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-safe-test-"));
  try {
    await writeFile(path.join(root, "a.txt"), "hello");
    await assert.rejects(safeFile(root, "../a.txt"));
    await assert.rejects(safeFile(root, "a.txt", 2));
    await symlink(root, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(safeFile(root, "link/a.txt"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real node runner: success, failure, environment isolation, duplicate lock, stop and timeout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-execute-"));
  process.env.ATLAS_TEST_SECRET = "must-not-reach-child";
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test check.mjs" } }));
    await writeFile(path.join(root, "check.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; test("isolated", () => { assert.equal(process.env.ATLAS_TEST_SECRET, undefined); });');
    const [profile] = await discoverRunners(root);
    const run = await startRun(7101, root, profile, false, []);
    await assert.rejects(startRun(7102, root, profile, false, []), /已有测试/);
    assert.equal((await finish(run)).status, "passed");
    assert.match(run.output, /isolated/);
    await writeFile(path.join(root, "check.mjs"), 'import {test} from "node:test"; test("fails", () => { throw Error("expected fixture failure"); });');
    assert.equal((await finish(await startRun(7101, root, profile, false, []))).status, "failed");
    await writeFile(path.join(root, "check.mjs"), 'setInterval(() => {}, 1000);');
    const waiting = await startRun(7101, root, profile, false, []);
    await assert.rejects(async () => cancelRun(7101, "wrong-id"), /不存在/);
    await delay(100); cancelRun(7101, waiting.id);
    assert.equal((await finish(waiting)).status, "cancelled");
    assert.equal((await finish(await startRun(7101, root, profile, false, [], 100))).status, "timed-out");
    const missing = await startRun(7101, root, { ...profile, executable: path.join(root, "missing-executable") }, false, []);
    assert.equal((await finish(missing)).status, "error");
    await writeFile(path.join(root, "check.mjs"), 'console.log("x".repeat(200000));');
    const verbose = await finish(await startRun(7101, root, profile, false, []));
    assert.equal(verbose.truncated, true);
    assert.ok(verbose.output.length <= 128000);
    assert.equal(latestRun(7102), null);
  } finally { delete process.env.ATLAS_TEST_SECRET; await rm(root, { recursive: true, force: true }); }
});

test("coverage is from fresh temporary report and maps only unchanged imported source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-coverage-"));
  try {
    const content = "export function x() {\n return 1;\n}\n";
    await writeFile(path.join(root, "main.js"), content);
    await writeFile(path.join(root, "stale.js"), "changed source");
    await writeFile(path.join(root, "runner.mjs"), 'import {writeFileSync} from "node:fs"; import {join} from "node:path"; const dir = process.argv.find(a => a.startsWith("--coverageDirectory=")).split("=").slice(1).join("="); writeFileSync(join(dir,"lcov.info"), "SF:main.js\\nDA:2,1\\nend_of_record\\nSF:stale.js\\nDA:1,1\\nend_of_record\\n");');
    const profile = { id: "fixture", label: "fixture", command: "fixture", coverage: true, kind: "jest" as const, executable: process.execPath, args: [path.join(root, "runner.mjs")] };
    const run = await finish(await startRun(7103, root, profile, true, [{ path: "main.js", content }, { path: "stale.js", content: "original" }]));
    assert.equal(run.status, "passed");
    assert.deepEqual(run.coverage, [{ path: "main.js", lines: [{ line: 2, hits: 1 }], sourceHash: hashSource(content) }]);
    assert.match(run.coverageNote, /1 个文件/);
    await writeFile(path.join(root, "runner.mjs"), "// No report for this run");
    const next = await finish(await startRun(7103, root, profile, true, [{ path: "main.js", content }]));
    assert.deepEqual(next.coverage, []);
    assert.match(next.coverageNote, /未生成有效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trace run injects the pytest plugin env and parses recorded calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-trace-"));
  const report = JSON.stringify({
    target: { file: "mylib.py", func: "add" }, calls: 2, nodeCount: 3, truncated: false,
    roots: [
      { id: 1, func: "add", args: [{ name: "x", value: "1" }], ret: "1", line: 5, depth: 0, children: [] },
      { id: 2, func: "add", args: [{ name: "x", value: "2" }], ret: "2", line: 5, depth: 0, children: [
        { id: 3, func: "add", args: [{ name: "x", value: "3" }], ret: null, line: 6, depth: 1, children: [] },
      ] },
    ],
  });
  try {
    // 假 runner：校验注入的环境变量，然后按插件格式写结果。
    await writeFile(path.join(root, "fake.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      "const out = process.env.ATLAS_TRACE_OUT;",
      "const pp = process.env.PYTHONPATH || '';",
      "if (!out || !pp.includes('pytest') || process.env.ATLAS_TRACE_FILE !== 'mylib.py' || process.env.ATLAS_TRACE_FUNC !== 'add') {",
      "  console.error('trace env not injected: ' + pp); process.exit(3);",
      "}",
      "writeFileSync(out, " + JSON.stringify(report) + ");",
    ].join("\n"));
    const profile = { id: "pytest", label: "pytest", command: "python -m pytest", coverage: false, kind: "pytest" as const, executable: process.execPath, args: [path.join(root, "fake.mjs")] };

    const run = await finish(await startRun(7201, root, profile, false, [], 60_000, { file: "mylib.py", func: "add" }));
    assert.equal(run.status, "passed");
    assert.match(run.command, /-p atlas_trace_plugin/);
    assert.equal(run.trace?.calls, 2);
    assert.equal(run.trace?.target.func, "add");
    assert.equal(run.trace?.roots[0].args[0].value, "1");
    assert.equal(run.trace?.roots[1].children[0].depth, 1);

    // 插件没写出结果时，给出可解释的说明而不是空对象。
    await writeFile(path.join(root, "fake.mjs"), "process.exit(0);");
    const missing = await finish(await startRun(7201, root, profile, false, [], 60_000, { file: "mylib.py", func: "add" }));
    assert.equal(missing.trace?.calls, 0);
    assert.match(missing.trace?.note ?? "", /没有产出追踪结果/);

    await assert.rejects(startRun(7202, root, { ...profile, kind: "node" }, false, [], 60_000, { file: "mylib.py", func: "add" }), /只支持 pytest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
