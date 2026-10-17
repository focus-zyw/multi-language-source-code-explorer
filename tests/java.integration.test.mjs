import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkLanguageImport } from "./support/language-import-check.mjs";

test("Java imports classes and method details, analyzes flow and exposes overload candidates", { timeout: 60000 }, async () => {
  const files = ["Base", "MathUtil", "Counter", "CounterTest"].map((name) => [`demo/${name}.java`, readFileSync(new URL(`./fixtures/java_app/demo/${name}.java`, import.meta.url), "utf8")]);
  await checkLanguageImport("java", files, async ({ tree, detail, analysis }) => {
    const add = tree.symbols.find((s) => s.qualifiedName === "Counter.add");
    assert.ok(add);
    assert.equal((await detail(add)).file.language, "java");
    assert.ok((await analysis(add)).flow.nodes.some((n) => n.kind === "handler"));
    const run = tree.symbols.find((s) => s.qualifiedName === "Counter.run");
    assert.ok((await detail(run)).outgoing.some((r) => r.resolution === "heuristic" && r.targets.length === 2));
    assert.ok(tree.symbols.some((s) => s.kind === "test" && s.name === "adds"));
  });
});
