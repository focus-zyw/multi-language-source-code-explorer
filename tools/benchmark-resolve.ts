/**
 * Pure in-memory benchmark; fixture source is parsed, never executed.
 * node --experimental-strip-types tools/benchmark-resolve.ts
 * Add --compare-ref <git-ref> to assert complete output equality with that revision.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";
import { resolveProject, type FileUnit } from "../src/lib/analysis/resolve.ts";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--compare-ref" || args[1].startsWith("-"))) {
  throw new Error("Usage: benchmark-resolve.ts [--compare-ref <git-ref>]");
}
let baseline: typeof resolveProject | undefined;
if (args.length) {
  // resolve.ts has only type imports; its trusted repository version is self-contained.
  const source = execFileSync("git", ["show", `${args[1]}:src/lib/analysis/resolve.ts`], { encoding: "utf8" });
  const code = stripTypeScriptTypes(source);
  const loaded: unknown = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  if (!loaded || typeof loaded !== "object" || !("resolveProject" in loaded) || typeof loaded.resolveProject !== "function") {
    throw new Error("The comparison revision does not export resolveProject");
  }
  baseline = loaded.resolveProject as typeof resolveProject;
}

const entry = pluginForPath("C.java")!;
const source = "package bench; class C { int helper(int n){ return n; } " + Array.from({ length: 20 }, (_, i) =>
  `int work${i}(int n){ ${Array.from({ length: 5 }, () => "helper(n);").join(" ")} return n; }`).join("\n") + " }";
const tree = (await parseSource(entry.grammar, source))!;
let extract: FileUnit["extract"];
try { extract = entry.plugin.extract(tree.rootNode, source, "C.java"); }
finally { tree.delete(); }

function measure(run: typeof resolveProject, files: FileUnit[], ids: number[][]) {
  const samples: number[] = [];
  let output: ReturnType<typeof resolveProject> | undefined;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const result = run(files, ids);
    samples.push(performance.now() - start);
    if (output) assert.deepEqual(result, output);
    output = result;
  }
  return { medianMs: Math.round(samples.sort((a, b) => a - b)[1] * 10) / 10, output: output! };
}

for (const count of [25, 100, 250]) {
  const files: FileUnit[] = Array.from({ length: count }, (_, idx) => ({ idx, path: `pkg${idx}/C.java`, language: "java", plugin: entry.plugin, isTest: false, extract }));
  const ids = files.map((file) => file.extract.symbols.map((_, i) => file.idx * 100 + i + 1));
  const before = baseline ? measure(baseline, files, ids) : null;
  const after = measure(resolveProject, files, ids);
  if (before) assert.deepEqual(after.output, before.output);
  console.log(JSON.stringify({ files: count, symbols: count * extract.symbols.length, calls: after.output.refs.length,
    baselineMedianMs: before?.medianMs, currentMedianMs: after.medianMs, completeOutputEqual: before ? true : undefined }));
}
