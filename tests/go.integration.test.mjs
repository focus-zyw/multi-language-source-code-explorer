import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkLanguageImport } from "./support/language-import-check.mjs";

test("Go imports, browses receiver methods, analyzes flow and links package calls", { timeout: 60000 }, async () => {
  const files = ["counter.go", "helpers.go", "counter_test.go"].map((name) => [name, readFileSync(new URL(`./fixtures/go_app/${name}`, import.meta.url), "utf8")]);
  await checkLanguageImport("go", files, async ({ tree, detail, analysis }) => {
    const method = tree.symbols.find((s) => s.qualifiedName === "Counter.Add");
    assert.ok(method);
    const data = await detail(method);
    assert.equal(data.file.language, "go");
    assert.ok(data.outgoing.some((ref) => ref.targets.some((target) => target.name === "Double")));
    assert.ok(data.summary.headline.includes("Add"));
    const graph = await analysis(method);
    assert.ok(graph.flow.nodes.some((node) => node.kind === "loop"));
    assert.ok(tree.symbols.some((s) => s.kind === "test" && s.name === "TestDouble"));
  });
});
