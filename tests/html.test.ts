import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";
import { buildStaticSummary } from "../src/lib/analysis/summary.ts";

async function extract(source: string, path = "index.html") {
  const entry = pluginForPath(path)!;
  assert.equal(entry.plugin.id, "html");
  const tree = (await parseSource(entry.grammar, source))!;
  try { return entry.plugin.extract(tree.rootNode, source, path); } finally { tree.delete(); }
}

test("HTML structure retains hierarchy, attributes, repeated tags and Unicode source ranges", async () => {
  const source = '<!DOCTYPE html>\n<html><body>\n<main id="内容"><p>你好😀</p><p>第二段</p><input disabled></main>\n</body></html>';
  const result = await extract(source);
  assert.equal(result.hasSyntaxErrors, false);
  const main = result.symbols.find((s) => s.name === "<main#内容>")!;
  assert.equal(main.startLine, 3);
  assert.ok(source.slice(main.startIndex, main.endIndex).startsWith('<main id="内容">'));
  const children = result.symbols.filter((s) => s.parentLocalId === main.localId);
  assert.deepEqual(children.map((s) => s.name), ["<p>", "<p>", "<input>"]);
  assert.notEqual(children[0].qualifiedName, children[1].qualifiedName);
  assert.ok(main.docstring?.includes('id="内容"'));
  assert.ok(result.symbols.every((s) => s.kind === "element"));
  const summary = buildStaticSummary({ ...main, filePath: "index.html", childCount: children.length, calls: [], testCount: 0 });
  assert.ok(summary.bullets.some((s) => s.includes("直接子节点 3")));
  assert.ok(!summary.bullets.some((s) => s.includes("无参数")));
});

test("HTML never executes or fabricates calls for scripts, event handlers and external resources", async () => {
  const result = await extract('<script>throw new Error("never run")</script><script src="./app.js"></script><button onclick="go()">ok</button>', "PAGE.HTM");
  assert.equal(result.symbols.filter((s) => s.name === "<script>").length, 2);
  assert.equal(result.calls.length, 0);
  assert.equal(result.imports.length, 0);
});

test("HTML empty, malformed and deeply nested documents remain bounded", async () => {
  assert.equal((await extract("")).symbols.length, 1);
  assert.equal((await extract("<div><span>")).hasSyntaxErrors, true);
  const deep = await extract("<div>".repeat(100) + "x" + "</div>".repeat(100));
  assert.ok(deep.warnings?.length);
  assert.ok(deep.symbols.length <= 81);
});
