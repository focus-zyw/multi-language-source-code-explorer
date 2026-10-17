import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";
import { findNodeByRange } from "../src/lib/analysis/util.ts";
import { buildFlowGraph } from "../src/lib/analysis/flow.ts";
import { resolveProject, type FileUnit } from "../src/lib/analysis/resolve.ts";
import { linkTests } from "../src/lib/analysis/tests-link.ts";
import { identifyProjectEntries } from "../src/lib/analysis/project-entries.ts";

const names = ["Base", "MathUtil", "Counter", "CounterTest"];
const fixture = (name: string) => readFileSync(new URL(`./fixtures/java_app/demo/${name}.java`, import.meta.url), "utf8");
async function units(): Promise<FileUnit[]> {
  return Promise.all(names.map(async (name, idx) => {
    const path = `demo/${name}.java`;
    const plugin = pluginForPath(path)!;
    const tree = (await parseSource(plugin.grammar, fixture(name)))!;
    try { return { idx, path, language: plugin.plugin.id, plugin: plugin.plugin, isTest: plugin.plugin.isTestFile(path), extract: plugin.plugin.extract(tree.rootNode, fixture(name), path) }; }
    finally { tree.delete(); }
  }));
}

test("Java extracts classes, constructors, overloads, docs, annotations and JUnit tests", async () => {
  const files = await units();
  assert.equal(files.every((f) => !f.extract.hasSyntaxErrors), true);
  const counter = files[2].extract;
  assert.equal(counter.moduleName, "demo");
  assert.deepEqual(counter.symbols[0].bases, ["Base"]);
  assert.equal(counter.symbols[0].docstring, "累计示例。");
  assert.equal(counter.symbols.filter((s) => s.name === "convert").length, 2);
  assert.equal(counter.symbols.find((s) => s.name === "constructor")?.qualifiedName, "Counter.Counter");
  const method = counter.symbols.find((s) => s.name === "add")!;
  assert.equal(method.docstring, "增加计数。");
  assert.equal(method.params[0].type, "int");
  assert.equal(fixture("Counter").slice(method.startIndex, method.endIndex).startsWith("public int add"), true);
  assert.equal(files[3].extract.symbols.find((s) => s.name === "adds")?.kind, "test");
});

test("Java resolves imports, inherited methods and constructors, keeping overloads as candidates", async () => {
  const files = await units();
  const ids = files.map((f) => f.extract.symbols.map((_, i) => f.idx * 100 + i + 1));
  const out = resolveProject(files, ids);
  for (const name of ["twice", "inc"]) {
    const call = out.refs.find((r) => r.fileIdx === 2 && r.call.name === name)!;
    assert.equal(call.resolution, "inferred", name);
    assert.equal(call.targets.length, 1);
  }
  const overload = out.refs.find((r) => r.fileIdx === 2 && r.call.name === "convert")!;
  assert.equal(overload.resolution, "heuristic");
  assert.equal(overload.targets.length, 2);
  assert.ok(overload.targets.every((t) => t.confidence === "heuristic"));
  assert.ok(out.refs.some((r) => r.call.kind === "new" && r.call.name === "Counter" && r.targets.length === 1));
  const links = linkTests(files, ids, out.refs);
  assert.ok(links.some((link) => link.targetSymbolId === ids[2][files[2].extract.symbols.findIndex((s) => s.name === "add")] && link.method === "direct-call"));
});

test("Java flow and variables include branches, loops, exceptions, fields and catch bindings", async () => {
  const source = fixture("Counter");
  const entry = pluginForPath("Counter.java")!;
  const tree = (await parseSource(entry.grammar, source))!;
  try {
    const method = entry.plugin.extract(tree.rootNode, source, "Counter.java").symbols.find((s) => s.name === "add")!;
    const def = findNodeByRange(tree.rootNode, method.defStartIndex, method.defEndIndex)!;
    const graph = buildFlowGraph(entry.plugin.flowIR(def, source), method.name, method.startLine, method.endLine);
    for (const kind of ["loop", "decision", "try", "handler", "throw", "switch", "return"]) assert.ok(graph.nodes.some((n) => n.kind === kind), kind);
    const variables = entry.plugin.analyzeVariables(def, source);
    assert.equal(variables.find((v) => v.name === "amount")?.kind, "param");
    assert.equal(variables.find((v) => v.name === "i")?.kind, "loop");
    assert.equal(variables.find((v) => v.name === "ex")?.kind, "catch");
    assert.equal(variables.find((v) => v.name === "this.value")?.definition?.where, "class");
  } finally { tree.delete(); }
});

test("Java project overview offers the main method inside its owning class", async () => {
  const files = await units();
  let id = 1;
  const symbols = files.flatMap((f) => f.extract.symbols.map((s) => ({ ...s, id: id++, fileId: f.idx, parentId: s.parentLocalId })));
  const entries = identifyProjectEntries(files.map((f) => ({ id: f.idx, path: f.path, isTest: f.isTest })), symbols, new Set());
  assert.ok(entries.groups.find((g) => g.id === "startup")?.entries.some((e) => e.symbol.name === "Counter.main"));
});
