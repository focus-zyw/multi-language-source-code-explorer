import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";
import { findNodeByRange } from "../src/lib/analysis/util.ts";
import { buildFlowGraph } from "../src/lib/analysis/flow.ts";
import { resolveProject, type FileUnit } from "../src/lib/analysis/resolve.ts";

const sourceOf = (name: string) => readFileSync(new URL(`./fixtures/vue_app/${name}`, import.meta.url), "utf8");
async function unit(path: string, source: string, idx = 0): Promise<FileUnit> {
  const entry = pluginForPath(path)!;
  const tree = (await parseSource(entry.grammar, source))!;
  try { return { idx, path, plugin: entry.plugin, language: entry.plugin.id, isTest: entry.plugin.isTestFile(path), extract: entry.plugin.extract(tree.rootNode, source, path) }; }
  finally { tree.delete(); }
}

test("Vue script setup preserves original UTF-16 offsets, TS signatures and component entry", async () => {
  const source = sourceOf("Counter.vue");
  const { extract } = await unit("Counter.vue", source);
  assert.equal(extract.hasSyntaxErrors, false);
  assert.equal(extract.symbols[0].name, "Counter");
  assert.equal(extract.symbols[0].isDefaultExport, true);
  const method = extract.symbols.find((s) => s.name === "increment")!;
  assert.equal(source.slice(method.startIndex, method.endIndex).startsWith("function increment"), true);
  assert.equal(method.startLine, source.slice(0, method.startIndex).split("\n").length);
  assert.equal(method.params[0].type, "number");
  assert.equal(extract.symbols.filter((s) => s.name === "format").length, 1);
});

test("Vue script calls, imported components and template handlers keep their own owners and confidence", async () => {
  const paths = ["Counter.vue", "Child.vue", "math.ts"];
  const files = await Promise.all(paths.map((path, i) => unit(path, sourceOf(path), i)));
  const ids = files.map((f) => f.extract.symbols.map((_, i) => f.idx * 100 + i + 1));
  const result = resolveProject(files, ids);
  const script = result.refs.find((r) => r.call.name === "double")!;
  assert.equal(script.resolution, "exact");
  assert.equal(script.ownerSymbolId, ids[0][files[0].extract.symbols.findIndex((s) => s.name === "increment")]);
  const component = result.refs.find((r) => r.call.kind === "jsx" && r.call.name === "Child")!;
  assert.equal(component.resolution, "inferred");
  assert.equal(component.targets[0].symbolId, ids[1][0]);
  const handler = result.refs.find((r) => r.call.origin === "vue-template" && r.call.name === "increment")!;
  assert.equal(handler.resolution, "inferred");
  assert.equal(handler.ownerSymbolId, ids[0][0]);
  assert.ok(result.refs.some((r) => r.call.name === "ref" && r.ownerSymbolId === ids[0][0] && r.resolution === "external"));
});

test("Vue Options API methods are browsable and this calls are inferred within their component", async () => {
  const file = await unit("Options.vue", sourceOf("Options.vue"));
  const ids = [file.extract.symbols.map((_, i) => i + 1)];
  const result = resolveProject([file], ids);
  assert.equal(file.extract.symbols.find((s) => s.name === "increment")?.qualifiedName, "Options.increment");
  const calls = result.refs.filter((r) => r.call.name === "increment");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((r) => r.resolution === "inferred"));
});

test("Vue method and setup flow reparse correctly, and variables retain source locations", async () => {
  const source = sourceOf("Counter.vue");
  const entry = pluginForPath("Counter.vue")!;
  const tree = (await parseSource(entry.grammar, source))!;
  try {
    const extracted = entry.plugin.extract(tree.rootNode, source, "Counter.vue");
    for (const symbol of [extracted.symbols[0], extracted.symbols.find((s) => s.name === "increment")!]) {
      const def = findNodeByRange(tree.rootNode, symbol.defStartIndex, symbol.defEndIndex)!;
      assert.ok(def);
      const graph = buildFlowGraph(entry.plugin.flowIR(def, source), symbol.name, symbol.startLine, symbol.endLine);
      assert.ok(graph.nodes.length > 2);
      const vars = entry.plugin.analyzeVariables(def, source);
      assert.ok(vars.some((v) => v.name === (symbol.name === "Counter" ? "count" : "step")));
    }
  } finally { tree.delete(); }
});

test("Vue handles two script blocks, template-only components, unsupported languages and external scripts honestly", async () => {
  const mixed = '<script>export const shared = 1</script>\n<template><p>ok</p></template>\n<script setup lang="ts">function identity<T>(value: T): T { return value }</script>';
  const file = await unit("Mixed.vue", mixed);
  assert.equal(file.extract.hasSyntaxErrors, false);
  assert.ok(file.extract.symbols.some((s) => s.name === "identity"));
  const template = await unit("Template.vue", "<template><p>文字 😀</p></template>");
  assert.equal(template.extract.symbols.length, 1);
  assert.equal(template.extract.hasSyntaxErrors, false);
  const unsupported = await unit("Coffee.vue", '<script lang="coffee">unhandled = -> 1</script>');
  assert.equal(unsupported.extract.hasSyntaxErrors, true);
  assert.ok(unsupported.extract.warnings?.length);
  const external = await unit("External.vue", '<script src="./other.ts"></script>');
  assert.ok(external.extract.warnings?.some((warning) => warning.includes("不会自动加载")));
});

test("Vue template-local aliases cannot be mistaken for same-named script handlers", async () => {
  const source = '<template><div v-for="increment in handlers"><button @click="increment">local</button></div><button @click="increment">script</button></template><script setup>const handlers = []; function increment(){ return 1; }</script>';
  const file = await unit("Shadow.vue", source);
  assert.equal(file.extract.calls.filter((call) => call.origin === "vue-template" && call.name === "increment").length, 1);
});

test("TypeScript imports Vue default components and explicitly exported script helpers", async () => {
  const files = [
    await unit("Exported.vue", '<template><p>ok</p></template><script lang="ts">export function helper(){ return 1; } export default {}</script>', 0),
    await unit("entry.ts", 'import Component, { helper } from "./Exported.vue"; export function entry(){ helper(); Component(); }', 1),
  ];
  const ids = files.map((f) => f.extract.symbols.map((_, i) => f.idx * 100 + i + 1));
  const result = resolveProject(files, ids);
  const helper = result.refs.find((r) => r.call.name === "helper")!;
  assert.equal(helper.resolution, "exact");
  assert.equal(helper.targets[0].symbolId, ids[0][1]);
  assert.equal(result.refs.find((r) => r.call.name === "Component")?.targets[0].symbolId, ids[0][0]);
});
