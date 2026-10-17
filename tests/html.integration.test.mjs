// Requires a running local app; creates and deletes only this test's project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLanguageImport } from "./support/language-import-check.mjs";

test("HTML import, structure navigation and static explanation", async () => {
  await checkLanguageImport("html", [["index.html", '<html><body><main id="app"><button>按钮</button></main></body></html>']], async ({ tree, detail, root }) => {
    const main = tree.symbols.find((s) => s.name === "<main#app>");
    assert.ok(main);
    const child = tree.symbols.find((s) => s.parentId === main.id);
    assert.equal(child.name, "<button>");
    const data = await detail(main);
    assert.equal(data.children[0].id, child.id);
    assert.ok(data.summary.bullets.some((s) => s.includes("直接子节点 1")));
    assert.equal(data.outgoing.length, 0);
    const analysis = await (await fetch(`${root}/symbols/${main.id}/analysis`)).json();
    assert.equal(analysis.flow, null);
    assert.ok(analysis.notes.some((s) => s.includes("结构")));
  });
});
