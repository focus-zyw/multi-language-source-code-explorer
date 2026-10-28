import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";
import { findNodeByRange } from "../src/lib/analysis/util.ts";
import { buildFlowGraph } from "../src/lib/analysis/flow.ts";
import { resolveProject, type FileUnit } from "../src/lib/analysis/resolve.ts";
import { linkTests } from "../src/lib/analysis/tests-link.ts";
import { classifyPath } from "../src/lib/ingest/rules.ts";

async function unit(path: string, source: string, idx: number): Promise<FileUnit> {
  const entry = pluginForPath(path)!;
  const tree = (await parseSource(entry.grammar, source))!;
  try { return { idx, path, plugin: entry.plugin, language: entry.plugin.id, isTest: entry.plugin.isTestFile(path), extract: entry.plugin.extract(tree.rootNode, source, path) }; }
  finally { tree.delete(); }
}
const fixture = (name: string) => readFileSync(new URL(`./fixtures/go_app/${name}`, import.meta.url), "utf8");

test("Go extracts structs, receiver methods, grouped parameters, docs and exact source ranges", async () => {
  const source = fixture("counter.go");
  const u = await unit("demo/counter.go", source, 0);
  assert.equal(classifyPath("demo/counter.go"), null);
  assert.equal(u.extract.hasSyntaxErrors, false);
  const method = u.extract.symbols.find((s) => s.name === "Add")!;
  assert.equal(method.qualifiedName, "Counter.Add");
  assert.equal(u.extract.symbols[method.parentLocalId!].name, "Counter");
  assert.equal(method.docstring, "Add 累加正数。");
  assert.equal(source.slice(method.startIndex, method.endIndex).startsWith("func (c *Counter) Add"), true);
  assert.equal(method.params[0].type, "[]int");
  assert.equal(method.metrics.loops, 1);
  const grouped = await unit("grouped.go", "package demo\nfunc sum(x, y int, rest ...int) int { return x+y }", 0);
  assert.deepEqual(grouped.extract.symbols[0].params.map((p) => p.name), ["x", "y", "rest"]);
});

test("Go package calls and typed receivers resolve across files; unrelated languages are excluded", async () => {
  const units = await Promise.all(["counter.go", "helpers.go", "counter_test.go"].map((name, idx) => unit(`demo/${name}`, fixture(name), idx)));
  units.push(await unit("web.js", "function Double() {}", 3));
  const ids = units.map((u) => u.extract.symbols.map((_, i) => u.idx * 100 + i + 1));
  const resolved = resolveProject(units, ids);
  const double = resolved.refs.find((r) => r.fileIdx === 0 && r.call.name === "Double")!;
  assert.equal(double.resolution, "inferred");
  assert.equal(double.targets[0].symbolId, ids[1][0]);
  const add = resolved.refs.find((r) => r.fileIdx === 1 && r.call.name === "Add")!;
  assert.equal(add.resolution, "inferred");
  assert.equal(add.targets[0].symbolId, ids[0][1]);
  const testSymbol = units[2].extract.symbols[0];
  assert.equal(testSymbol.kind, "test");
  assert.ok(linkTests(units, ids, resolved.refs).some((link) => link.targetSymbolId === ids[1][0] && link.method === "direct-call"));
});

test("Go flow and variables preserve loops, branches, return paths and range declarations", async () => {
  const source = fixture("counter.go");
  const plugin = pluginForPath("counter.go")!;
  const tree = (await parseSource(plugin.grammar, source))!;
  try {
    const s = plugin.plugin.extract(tree.rootNode, source, "counter.go").symbols.find((s) => s.name === "Add")!;
    const def = findNodeByRange(tree.rootNode, s.defStartIndex, s.defEndIndex)!;
    const graph = buildFlowGraph(plugin.plugin.flowIR(def, source), s.name, s.startLine, s.endLine);
    for (const kind of ["loop", "decision", "switch", "return"]) assert.ok(graph.nodes.some((n) => n.kind === kind));
    assert.ok(graph.edges.some((e) => e.kind === "back"));
    const variables = plugin.plugin.analyzeVariables(def, source);
    assert.equal(variables.find((v) => v.name === "values")?.kind, "param");
    assert.equal(variables.find((v) => v.name === "value")?.kind, "loop");
    assert.equal(variables.find((v) => v.name === "c.Value")?.definition?.where, "class");
    assert.ok(variables.find((v) => v.name === "total")?.tags.includes("returned"));
  } finally { tree.delete(); }
});

test("Go package imports search all sibling files and preserve external standard library calls", async () => {
  const sources = [
    ["main.go", 'package main\nimport ( d "example.org/app/demo"; "fmt" )\nfunc main(){ fmt.Println(d.Double(2)) }'],
    ["demo/a.go", "package demo\ntype Counter struct {}"],
    ["demo/z.go", "package demo\nfunc Double(n int) int { return n*2 }"],
  ];
  const units = await Promise.all(sources.map(([path, source], idx) => unit(path, source, idx)));
  const resolved = resolveProject(units, [[1], [2], [3]]);
  assert.equal(resolved.refs.find((r) => r.call.name === "Double")?.resolution, "inferred");
  assert.equal(resolved.refs.find((r) => r.call.name === "Double")?.targets[0].symbolId, 3);
  assert.equal(resolved.refs.find((r) => r.call.name === "Println")?.resolution, "external");
});

test("Go imported package lookup ignores other directories/languages and preserves ambiguous siblings", async () => {
  const sources = [
    ["main.go", 'package main\nimport d "example.org/app/demo"\nfunc main(){ d.Double(2) }'],
    ["demo/a.go", "package demo\ntype Counter struct {}"],
    ["demo/z.go", "package demo\nfunc Double(n int) int { return n*2 }"],
    ["other/double.go", "package demo\nfunc Double(n int) int { return n*3 }"],
    ["demo/double.js", "function Double(n) { return n*4; }"],
  ];
  const files = await Promise.all(sources.map(([path, source], idx) => unit(path, source, idx)));
  const ids = files.map((file) => file.extract.symbols.map((_, i) => file.idx * 100 + i + 1));
  const unique = resolveProject(files, ids).refs.find((ref) => ref.fileIdx === 0 && ref.call.name === "Double")!;
  assert.equal(unique.resolution, "inferred");
  assert.deepEqual(unique.targets.map((target) => target.symbolId), [ids[2][0]]);
  const duplicate = await unit("demo/zz.go", "package demo\nfunc Double(n int) int { return n*5 }", files.length);
  const ambiguous = resolveProject([...files, duplicate], [...ids, [501]]).refs.find((ref) => ref.fileIdx === 0 && ref.call.name === "Double")!;
  assert.equal(ambiguous.resolution, "unresolved");
  assert.deepEqual(ambiguous.targets, []);
});
