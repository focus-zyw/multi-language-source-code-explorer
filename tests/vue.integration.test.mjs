import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkLanguageImport } from "./support/language-import-check.mjs";

test("Vue imports scripts with original line numbers and connects component, template and TS calls", { timeout: 60000 }, async () => {
  const files = ["Counter.vue", "Child.vue", "Options.vue", "math.ts"].map((name) => [name, readFileSync(new URL(`./fixtures/vue_app/${name}`, import.meta.url), "utf8")]);
  await checkLanguageImport("vue", files, async ({ tree, detail, analysis, root }) => {
    const component = tree.symbols.find((s) => s.name === "Counter");
    assert.ok(component);
    const data = await detail(component);
    assert.equal(data.file.language, "vue");
    assert.ok(data.outgoing.some((r) => r.targets.some((target) => target.name === "Child")));
    const method = tree.symbols.find((s) => s.name === "increment" && s.fileId === component.fileId);
    assert.ok(method);
    assert.ok((await analysis(method)).flow.nodes.some((n) => n.kind === "decision"));
    assert.ok((await analysis(component)).notes.some((note) => note.includes("模板静态绑定") || note.includes("模板边")));
    const entries = await (await fetch(`${root}/entries`)).json();
    assert.ok(entries.groups.find((g) => g.id === "pages")?.entries.some((e) => e.symbol.name === "Counter"));
  });
});
