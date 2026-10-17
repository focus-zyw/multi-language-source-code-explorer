// Requires a running local app; creates and deletes only this test's project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLanguageImport } from "./support/language-import-check.mjs";

test("JSON import, configuration hierarchy and explanation facts", async () => {
  await checkLanguageImport("json", [["package.json", '{"scripts":{"dev":"next dev"},"dependencies":{"next":"16.2.6"}}']], async ({ tree, detail, root }) => {
    const scripts = tree.symbols.find((s) => s.qualifiedName === '$["scripts"]');
    const dev = tree.symbols.find((s) => s.qualifiedName === '$["scripts"]["dev"]');
    assert.equal(dev.parentId, scripts.id);
    const data = await detail(dev);
    assert.ok(data.symbol.docstring.includes("脚本"));
    assert.ok(data.summary.headline.includes("JSON 节点"));
    assert.ok(!data.summary.bullets.includes("无参数"));
    assert.equal(data.outgoing.length, 0);
    const analysis = await (await fetch(`${root}/symbols/${dev.id}/analysis`)).json();
    assert.equal(analysis.flow, null);
  });
});
