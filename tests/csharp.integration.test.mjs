import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkLanguageImport } from "./support/language-import-check.mjs";

test("C# imports classes and method details, analyzes flow and exposes overload candidates", { timeout: 60000 }, async () => {
  const files = ["Base", "MathUtil", "Counter", "CounterTests"].map((name) => [`Demo/${name}.cs`, readFileSync(new URL(`./fixtures/csharp_app/Demo/${name}.cs`, import.meta.url), "utf8")]);
  await checkLanguageImport("csharp", files, async ({ tree, detail, analysis }) => {
    const add = tree.symbols.find((symbol) => symbol.qualifiedName === "Counter.Add");
    assert.ok(add);
    assert.equal((await detail(add)).file.language, "csharp");
    assert.ok((await analysis(add)).flow.nodes.some((node) => node.kind === "handler"));
    const run = tree.symbols.find((symbol) => symbol.qualifiedName === "Counter.Run");
    assert.ok((await detail(run)).outgoing.some((ref) => ref.resolution === "heuristic" && ref.targets.length === 2));
    assert.ok(tree.symbols.some((symbol) => symbol.kind === "test" && symbol.name === "Adds"));
  });
});
