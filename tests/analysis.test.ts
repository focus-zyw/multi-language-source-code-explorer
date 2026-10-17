import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath, supportedExtensions } from "../src/lib/analysis/registry.ts";
import { findNodeByRange } from "../src/lib/analysis/util.ts";
import { buildFlowGraph } from "../src/lib/analysis/flow.ts";
import { resolveProject, type FileUnit } from "../src/lib/analysis/resolve.ts";
import { linkTests } from "../src/lib/analysis/tests-link.ts";
import { SUPPORTED_EXTENSIONS, classifyPath, normalizeEntryPath } from "../src/lib/ingest/rules.ts";
import { collectFromZip } from "../src/lib/ingest/zip.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function walkDir(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

async function analyzeFixtures() {
  const units: FileUnit[] = [];
  const sources: string[] = [];
  for (const rel of walkDir(FIXTURES).sort()) {
    const m = pluginForPath(rel);
    if (!m) continue;
    const src = fs.readFileSync(path.join(FIXTURES, rel), "utf8");
    const tree = (await parseSource(m.grammar, src))!;
    const extract = m.plugin.extract(tree.rootNode, src, rel);
    tree.delete();
    units.push({ idx: units.length, path: rel, language: m.plugin.id, plugin: m.plugin, extract, isTest: m.plugin.isTestFile(rel) });
    sources.push(src);
  }
  let id = 1;
  const symbolIds = units.map((u) => u.extract.symbols.map(() => id++));
  const resolved = resolveProject(units, symbolIds);
  const links = linkTests(units, symbolIds, resolved.refs);
  return { units, symbolIds, resolved, links, sources };
}

test("支持的扩展名在前后端规则与插件注册表中一致", () => {
  assert.deepEqual([...SUPPORTED_EXTENSIONS].sort(), [...supportedExtensions].sort());
});

test("提取符号：位置、类型与测试用例", async () => {
  const { units } = await analyzeFixtures();
  const byPath = (p: string) => units.find((u) => u.path === p)!;
  const models = byPath("py_app/app/models.py").extract;
  const deposit = models.symbols.find((s) => s.qualifiedName === "Account.deposit")!;
  assert.equal(deposit.kind, "method");
  assert.equal(deposit.startLine, 16);
  assert.equal(deposit.metrics.throws, 1);
  assert.match(deposit.docstring ?? "", /存入金额/);

  const pyTests = byPath("py_app/tests/test_services.py").extract.symbols.filter((s) => s.kind === "test").map((s) => s.qualifiedName);
  assert.deepEqual(pyTests.sort(), ["TestAccount.test_deposit", "test_transfer_insufficient", "test_transfer_ok"]);

  const jsTests = byPath("js_app/test/store.test.ts").extract.symbols.filter((s) => s.kind === "test").map((s) => s.name);
  assert.deepEqual(jsTests.sort(), ["adds items and computes total", "checkout throws on bad mode"]);
});

test("源码位置与非 ASCII 字符：索引可回切原文", async () => {
  const src = "# 中文注释 😀\ndef 函数(a):\n    return a\n";
  const m = pluginForPath("x.py")!;
  const tree = (await parseSource(m.grammar, src))!;
  const r = m.plugin.extract(tree.rootNode, src, "x.py");
  const s = r.symbols[0];
  assert.equal(src.slice(s.startIndex, s.endIndex), "def 函数(a):\n    return a");
  assert.equal(s.startLine, 2);
  const def = findNodeByRange(tree.rootNode, s.defStartIndex, s.defEndIndex);
  assert.equal(def?.type, "function_definition");
  tree.delete();
});

test("跨文件解析：确定 / 推断 / 无法解析 / 外部，且不把猜测当确定", async () => {
  const { units, resolved } = await analyzeFixtures();
  const fileOf = (p: string) => units.find((u) => u.path === p)!.idx;
  const refsIn = (p: string, owner: string, callee: string) =>
    resolved.refs.filter((r) => r.fileIdx === fileOf(p) && units[r.fileIdx].extract.symbols[r.call.ownerLocalId].qualifiedName === owner && r.call.calleeText === callee);

  const [self] = refsIn("py_app/app/models.py", "Account.deposit", "self._record");
  assert.equal(self.resolution, "exact");

  const [mod] = refsIn("py_app/app/services.py", "transfer", "utils.audit");
  assert.equal(mod.resolution, "exact");

  const [typed] = refsIn("py_app/app/services.py", "transfer", "src.withdraw");
  assert.equal(typed.resolution, "inferred"); // 来自类型标注，只能算“推断”

  const [unknown] = refsIn("py_app/app/services.py", "helper", "unknown_call");
  assert.equal(unknown.resolution, "unresolved");
  assert.equal(unknown.targets.length, 0);

  const [builtin] = refsIn("py_app/app/services.py", "transfer", "range");
  assert.equal(builtin.resolution, "external");

  const [tsMod] = refsIn("js_app/src/store.ts", "Cart.total", "math.add");
  assert.equal(tsMod.resolution, "exact");
  const [alias] = refsIn("js_app/src/store.ts", "Cart.add", "this.logger.info");
  assert.ok(alias.resolution === "inferred" || alias.resolution === "exact");
  assert.ok(alias.targets.every((t) => t.confidence !== "heuristic"));
});

test("测试关联：直接调用 / 间接调用，并且有可信度", async () => {
  const { units, symbolIds, links } = await analyzeFixtures();
  const idOf = (p: string, qn: string) => {
    const u = units.find((x) => x.path === p)!;
    return symbolIds[u.idx][u.extract.symbols.find((s) => s.qualifiedName === qn)!.localId];
  };
  const test = idOf("py_app/tests/test_services.py", "test_transfer_ok");
  const transfer = idOf("py_app/app/services.py", "transfer");
  const withdraw = idOf("py_app/app/models.py", "Account.withdraw");
  const direct = links.find((l) => l.testSymbolId === test && l.targetSymbolId === transfer)!;
  assert.equal(direct.method, "direct-call");
  assert.ok(direct.confidence === "exact" || direct.confidence === "inferred");
  const indirect = links.find((l) => l.testSymbolId === test && l.targetSymbolId === withdraw)!;
  assert.equal(indirect.confidence, "indirect");
  assert.ok(indirect.viaSymbolId !== null);
});

test("流程图与关键变量", async () => {
  const src = fs.readFileSync(path.join(FIXTURES, "py_app/app/services.py"), "utf8");
  const m = pluginForPath("services.py")!;
  const tree = (await parseSource(m.grammar, src))!;
  const r = m.plugin.extract(tree.rootNode, src, "services.py");
  const sym = r.symbols.find((s) => s.name === "transfer")!;
  const def = findNodeByRange(tree.rootNode, sym.defStartIndex, sym.defEndIndex)!;
  const g = buildFlowGraph(m.plugin.flowIR(def, src), sym.name, sym.startLine, sym.endLine);
  const kinds = g.nodes.map((n) => n.kind);
  for (const k of ["start", "end", "try", "handler", "loop", "decision", "return"]) assert.ok(kinds.includes(k as never), `缺少节点类型 ${k}`);
  assert.ok(g.edges.some((e) => e.kind === "back"), "循环应有回边");
  assert.ok(g.edges.every((e) => g.nodes.some((n) => n.id === e.source) && g.nodes.some((n) => n.id === e.target)));
  const vars = m.plugin.analyzeVariables(def, src);
  const amount = vars.find((v) => v.name === "amount")!;
  assert.equal(amount.kind, "param");
  assert.equal(amount.definition?.line, 8);
  assert.ok(vars.find((v) => v.name === "exc")?.kind === "catch");
  tree.delete();
});

test("路径安全：拒绝穿越、绝对路径与控制字符；跳过 node_modules/.git", () => {
  assert.equal(normalizeEntryPath("../etc/passwd").ok, false);
  assert.equal(normalizeEntryPath("a/../../b.py").ok, false);
  assert.equal(normalizeEntryPath("/etc/passwd").ok, false);
  assert.equal(normalizeEntryPath("C:\\Windows\\x.py").ok, false);
  assert.equal(normalizeEntryPath("a\0b.py").ok, false);
  const ok = normalizeEntryPath("a\\b/./c.py");
  assert.ok(ok.ok && ok.path === "a/b/c.py");
  assert.equal(classifyPath("node_modules/x/index.js"), "ignored-dir");
  assert.equal(classifyPath("src/.git/config"), "ignored-dir");
  assert.equal(classifyPath("src/a.d.ts"), "declaration-file");
  assert.equal(classifyPath("src/app.min.js"), "minified");
  assert.equal(classifyPath("README.md"), "unsupported-language");
  assert.equal(classifyPath("src/a.py"), null);
});

/** 构造最小 ZIP（store 方式），用于测试恶意条目 */
function makeZip(entries: { name: string; data: Buffer; symlink?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("ZIP 导入：穿越/绝对路径/符号链接/二进制/忽略目录均被拒绝或跳过", async () => {
  const zip = makeZip([
    { name: "proj/ok.py", data: Buffer.from("def a():\n    return 1\n") },
    { name: "proj/../evil.py", data: Buffer.from("x=1") },
    { name: "/abs/evil.py", data: Buffer.from("x=1") },
    { name: "proj/link.py", data: Buffer.from("ok.py"), symlink: true },
    { name: "proj/node_modules/m/index.js", data: Buffer.from("x") },
    { name: "proj/notes.md", data: Buffer.from("# hi") },
  ]);
  const r = await collectFromZip(zip);
  assert.deepEqual(r.files.map((f) => f.path), ["ok.py"]);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons["proj/../evil.py"], "path-traversal");
  assert.equal(reasons["/abs/evil.py"], "absolute-path");
  assert.equal(reasons["proj/link.py"], "symlink");
  assert.equal(reasons["node_modules/m/index.js"], "ignored-dir");
  assert.equal(reasons["notes.md"], "unsupported-language");
  assert.equal(r.rootName, "proj");
});
