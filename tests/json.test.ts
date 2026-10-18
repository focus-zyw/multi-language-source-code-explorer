import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";

async function extract(source: string, path = "package.json") {
  const entry = pluginForPath(path)!;
  assert.equal(entry.plugin.id, "json");
  const tree = (await parseSource(entry.grammar, source))!;
  try { return entry.plugin.extract(tree.rootNode, source, path); } finally { tree.delete(); }
}

test("dependency lock files retain a selectable document instead of thousands of indexed values", async () => {
  const source = JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`node_modules/pkg${i}`, { version: "1.0", integrity: "fixture" }])) });
  for (const path of ["package-lock.json", "nested/npm-shrinkwrap.json"]) {
    const result = await extract(source, path);
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0].endIndex, source.length);
    assert.ok(result.symbols[0].docstring?.includes("锁文件"));
    assert.ok(result.warnings?.some((s) => s.includes("锁文件")));
  }
  assert.ok((await extract(source, "data.json")).symbols.length > 1000);
});

test("JSON retains object/array hierarchy, precise ranges, types and escaped keys", async () => {
  const source = '{\n "scripts": {"dev": "next dev"},\n "数组😀": [true, null, {"a\\\"b": 9007199254740993}]\n}';
  const result = await extract(source);
  assert.equal(result.hasSyntaxErrors, false);
  const scripts = result.symbols.find((s) => s.qualifiedName === '$["scripts"]')!;
  const dev = result.symbols.find((s) => s.qualifiedName === '$["scripts"]["dev"]')!;
  assert.equal(dev.parentLocalId, scripts.localId);
  assert.ok(dev.docstring?.includes("脚本"));
  assert.ok(source.slice(dev.startIndex, dev.endIndex).startsWith('"dev":'));
  const large = result.symbols.find((s) => s.signature.includes('9007199254740993'))!;
  assert.ok(large.signature.includes("number"));
  assert.ok(large.qualifiedName.endsWith('["a\\\"b"]'));
  assert.equal(large.startLine, 3);
  assert.ok(result.symbols.some((s) => s.qualifiedName.endsWith("[0]") && s.signature.includes("boolean")));
  assert.ok(result.symbols.some((s) => s.qualifiedName.endsWith("[1]") && s.signature.includes("null")));
  assert.ok(result.symbols.every((s) => s.kind === "property"));
});

test("JSON explanations use file/path context and do not execute commands or resolve references", async () => {
  const source = '{"scripts":{"dev":"throw new Error()"},"dependencies":{"demo":"^1.0"},"port":3000,"$ref":"https://example.invalid/schema"}';
  const pkg = await extract(source);
  assert.ok(pkg.symbols.find((s) => s.qualifiedName === '$["dependencies"]["demo"]')?.docstring?.includes("不代表已安装"));
  const generic = await extract(source, "data.json");
  assert.ok(generic.symbols.find((s) => s.qualifiedName === '$["scripts"]["dev"]')?.docstring?.includes("不能仅凭键名"));
  assert.equal(generic.calls.length, 0);
  assert.equal(generic.imports.length, 0);
});

test("JSON preserves duplicate keys and descendants, and flags malformed/JSONC inputs", async () => {
  const duplicate = await extract('{"a":{"b":1},"a":{"b":2},"__proto__":null}');
  assert.equal(duplicate.symbols.length, 6);
  assert.equal(new Set(duplicate.symbols.map((s) => s.qualifiedName)).size, 6);
  assert.ok(duplicate.warnings?.some((s) => s.includes("重复键")));
  for (const source of ['', '{"a":}', '{"a":1,}', '{/* comment */"a":1}', 'true false']) assert.equal((await extract(source)).hasSyntaxErrors, true, source);
  for (const source of ['null', 'true', '12', '"text"', '{}', '[]']) assert.equal((await extract(source)).hasSyntaxErrors, false, source);
});

test("JSON caps deeply nested and wide data structures", async () => {
  const deep = await extract("[".repeat(100) + "0" + "]".repeat(100));
  assert.ok(deep.symbols.length <= 81);
  assert.ok(deep.warnings?.length);
  const wide = await extract(JSON.stringify(Array(6000).fill(0)));
  assert.equal(wide.symbols.length, 5000);
  assert.ok(wide.warnings?.length);
});
