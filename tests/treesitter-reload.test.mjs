import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/lib/analysis/treesitter.ts", import.meta.url);
const require = createRequire(sourceUrl);
// Next's separate route bundles / hot reloads evaluate this adapter again while
// Node retains the external CommonJS package. Match that boundary, not ESM's cache.
const compiled = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
function loadRouteCopy() {
  const routeModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(require, routeModule, routeModule.exports);
  return routeModule.exports;
}

test("separate route bundles and hot reloads can still parse after Tree-sitter initialization", async () => {
  const firstRoute = loadRouteCopy();
  const first = await firstRoute.parseSource("javascript", "function first() { return 1; }");
  assert.ok(first);
  assert.equal(first.rootNode.hasError, false);
  first.delete();
  assert.equal(typeof require("web-tree-sitter").init, "function");
  for (let i = 0; i < 4; i++) {
    const anotherRoute = loadRouteCopy();
    const tree = await anotherRoute.parseSource("typescript", "function next(value: number) { return value * 2; }");
    assert.ok(tree);
    assert.equal(tree.rootNode.hasError, false);
    tree.delete();
    assert.equal(await anotherRoute.getParser("javascript"), await firstRoute.getParser("javascript"));
  }
});
