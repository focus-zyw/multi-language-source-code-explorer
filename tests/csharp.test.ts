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
import type { IRStmt } from "../src/lib/analysis/types.ts";

const names = ["Base", "MathUtil", "Counter", "CounterTests"];
const fixture = (name: string) => readFileSync(new URL(`./fixtures/csharp_app/Demo/${name}.cs`, import.meta.url), "utf8");
async function unit(path: string, source: string, idx: number): Promise<FileUnit> {
  const entry = pluginForPath(path)!;
  const tree = (await parseSource(entry.grammar, source))!;
  try { return { idx, path, language: entry.plugin.id, plugin: entry.plugin, isTest: entry.plugin.isTestFile(path), extract: entry.plugin.extract(tree.rootNode, source, path) }; }
  finally { tree.delete(); }
}
async function units(): Promise<FileUnit[]> {
  return Promise.all(names.map((name, idx) => unit(`Demo/${name}.cs`, fixture(name), idx)));
}
function walkIr(stmts: IRStmt[], visit: (stmt: IRStmt) => void) {
  for (const stmt of stmts) {
    visit(stmt);
    if (stmt.t === "if") { walkIr(stmt.then, visit); walkIr(stmt.else, visit); }
    else if (stmt.t === "loop") walkIr(stmt.body, visit);
    else if (stmt.t === "try") { walkIr(stmt.body, visit); for (const handler of stmt.handlers) walkIr(handler.body, visit); walkIr(stmt.finally, visit); }
    else if (stmt.t === "switch") for (const item of stmt.cases) walkIr(item.body, visit);
  }
}

test("C# extracts types, constructors, docs, attributes, local functions and tests", async () => {
  const files = await units();
  assert.equal(files.every((file) => !file.extract.hasSyntaxErrors), true);
  const counter = files[2].extract;
  assert.equal(counter.moduleName, "Demo");
  assert.equal(counter.symbols.find((symbol) => symbol.name === "Counter")?.bases[0], "Base");
  assert.equal(counter.symbols.find((symbol) => symbol.name === "Counter")?.docstring, "累计示例。");
  assert.equal(files[0].extract.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "Kind"), true);
  const method = counter.symbols.find((symbol) => symbol.name === "Add")!;
  assert.equal(method.docstring, "增加计数。");
  assert.equal(method.params[0].type, "int");
  assert.equal(fixture("Counter").slice(method.startIndex, method.endIndex).includes("public int Add"), true);
  assert.equal(counter.symbols.find((symbol) => symbol.name === "constructor")?.qualifiedName, "Counter.Counter");
  assert.equal(counter.symbols.find((symbol) => symbol.name === "Nested")?.qualifiedName, "Counter.Local.Nested");
  assert.equal(counter.symbols.find((symbol) => symbol.name === "Nested")?.kind, "function");
  assert.equal(files[3].extract.symbols.find((symbol) => symbol.name === "Adds")?.kind, "test");
  assert.equal(files[3].isTest, true);
});

test("C# resolves namespaces, static imports, inheritance, local functions and overload candidates", async () => {
  const files = await units();
  const ids = files.map((file) => file.extract.symbols.map((_, index) => file.idx * 100 + index + 1));
  const out = resolveProject(files, ids);
  const twice = out.refs.find((ref) => ref.fileIdx === 2 && ref.call.name === "Twice")!;
  assert.equal(twice.resolution, "inferred");
  assert.equal(twice.targets.length, 1);
  const inc = out.refs.find((ref) => ref.fileIdx === 2 && ref.call.name === "Inc")!;
  assert.equal(inc.resolution, "inferred");
  assert.equal(inc.targets.length, 1);
  const nested = out.refs.find((ref) => ref.call.name === "Nested")!;
  assert.equal(nested.resolution, "exact");
  const overload = out.refs.find((ref) => ref.fileIdx === 2 && ref.call.name === "Convert")!;
  assert.equal(overload.resolution, "heuristic");
  assert.equal(overload.targets.length, 2);
  const links = linkTests(files, ids, out.refs);
  assert.ok(links.some((link) => link.targetSymbolId === ids[2][files[2].extract.symbols.findIndex((symbol) => symbol.name === "Add")] && link.method === "direct-call"));
});

test("C# flow and variables include branches, loops, exceptions, fields and catch bindings", async () => {
  const source = fixture("Counter");
  const entry = pluginForPath("Counter.cs")!;
  const tree = (await parseSource(entry.grammar, source))!;
  try {
    const method = entry.plugin.extract(tree.rootNode, source, "Counter.cs").symbols.find((symbol) => symbol.name === "Add")!;
    const def = findNodeByRange(tree.rootNode, method.defStartIndex, method.defEndIndex)!;
    const ir = entry.plugin.flowIR(def, source);
    const graph = buildFlowGraph(ir, method.name, method.startLine, method.endLine);
    for (const kind of ["loop", "decision", "try", "handler", "throw", "switch", "return"]) assert.ok(graph.nodes.some((node) => node.kind === kind), kind);
    let hasElse = false;
    walkIr(ir, (stmt) => { if (stmt.t === "if" && stmt.else.length) hasElse = true; });
    assert.equal(hasElse, true);
    const variables = entry.plugin.analyzeVariables(def, source);
    assert.equal(variables.find((item) => item.name === "amount")?.kind, "param");
    assert.equal(variables.find((item) => item.name === "i")?.kind, "loop");
    assert.equal(variables.find((item) => item.name === "item")?.kind, "loop");
    assert.equal(variables.find((item) => item.name === "ex")?.kind, "catch");
    assert.equal(variables.find((item) => item.name === "this.value")?.definition?.where, "class");
  } finally { tree.delete(); }
});

test("C# project overview offers static Main inside its owning class", async () => {
  const files = await units();
  let id = 1;
  const symbols = files.flatMap((file) => file.extract.symbols.map((symbol) => ({ ...symbol, id: id++, fileId: file.idx, parentId: symbol.parentLocalId })));
  const entries = identifyProjectEntries(files.map((file) => ({ id: file.idx, path: file.path, isTest: file.isTest })), symbols, new Set());
  assert.ok(entries.groups.find((group) => group.id === "startup")?.entries.some((entry) => entry.symbol.name === "Counter.Main"));
});

test("C# using imports keep namespace and container boundaries for overloads", async () => {
  const sources = [
    ["Demo/Worker.cs", `namespace Demo;
      class Worker {
        public Worker() {}
        public int Convert(string value) { return 1; }
        public int Convert(int value) { return value; }
        public int Single() { return 1; }
      }
      class Neighbor { public int Convert(double value) { return 2; } public int Single() { return 2; } }`],
    ["Demo/Other.cs", "namespace Demo; class Other { public int Convert(int value) { return 3; } public int Single() { return 3; } }"],
    ["Caller.cs", "using Demo; class Caller { void Run() { Worker worker = new Worker(); worker.Convert(1); worker.Single(); } }"],
    ["web.js", "class Worker { convert(value) { return value; } single() { return 4; } }"],
  ];
  const files = await Promise.all(sources.map(([path, source], idx) => unit(path, source, idx)));
  const ids = files.map((file) => file.extract.symbols.map((_, index) => file.idx * 100 + index + 1));
  const refs = resolveProject(files, ids).refs.filter((ref) => ref.fileIdx === 2);
  const overload = refs.find((ref) => ref.call.name === "Convert")!;
  const expected = files[0].extract.symbols.filter((symbol) => symbol.container === "Worker" && symbol.name === "Convert");
  assert.equal(expected.length, 2);
  assert.deepEqual(overload.targets.map((target) => target.symbolId), expected.map((symbol) => ids[0][symbol.localId]));
  assert.equal(overload.resolution, "heuristic");
  const single = refs.find((ref) => ref.call.name === "Single")!;
  assert.equal(single.resolution, "inferred");
  assert.equal(single.targets.length, 1);
  const constructor = refs.find((ref) => ref.call.kind === "new")!;
  assert.equal(constructor.targets.length, 1);
  assert.equal(constructor.targets[0].symbolId, ids[0][files[0].extract.symbols.find((symbol) => symbol.name === "constructor" && symbol.container === "Worker")!.localId]);
});
