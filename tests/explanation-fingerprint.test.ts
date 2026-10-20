import assert from "node:assert/strict";
import { test } from "node:test";
import { explanationContentKey, explanationMatchesConfig, fingerprintExplanation, storedExplanationFingerprint, type ExplanationFingerprintInput } from "../src/lib/explanation-fingerprint.ts";

function input(): ExplanationFingerprintInput {
  return { filePath: "src/main.ts", language: "typescript", source: "export function run(value) {\n  return helper(value);\n}",
    symbol: { qualifiedName: "run", kind: "function", signature: "export function run(value)", docstring: null, startLine: 10, endLine: 12, startCol: 1, endCol: 2,
      metrics: { loc: 3, params: 1, branches: 0, loops: 0, handlers: 0, returns: 1, throws: 0, awaits: 0, booleanOps: 0, complexity: 1 } },
    calls: [{ kind: "call", calleeText: "helper", line: 11, col: 10, resolution: "exact", targets: [{ filePath: "src/helper.ts", name: "helper", kind: "function", confidence: "exact" }] }] };
}

test("fingerprints ignore database IDs, CRLF and changes to absolute source positions", () => {
  const original = input();
  const shifted = { ...input(), filePath: "src\\main.ts", source: original.source.replaceAll("\n", "\r\n"),
    symbol: { ...original.symbol, id: 987, fileId: 654, startLine: 20, endLine: 22 },
    calls: original.calls.map((call) => ({ ...call, id: 555, line: call.line + 10, targets: call.targets.map((target) => ({ ...target, symbolId: 999, refId: 777 })) })) };
  assert.equal(fingerprintExplanation(original), fingerprintExplanation(shifted));
  assert.notEqual(fingerprintExplanation(original, true), fingerprintExplanation(shifted, true));
});

test("body, identity, analysis facts and resolved call targets invalidate fingerprints", () => {
  const original = input();
  for (const modified of [
    { ...original, source: original.source.replace("helper(value)", "helper(value + 1)") },
    { ...original, source: original.source + " // changed documentation" },
    { ...original, filePath: "other/main.ts" },
    { ...original, symbol: { ...original.symbol, qualifiedName: "Other.run" } },
    { ...original, symbol: { ...original.symbol, metrics: { ...original.symbol.metrics, complexity: 2 } } },
    { ...original, calls: original.calls.map((call) => ({ ...call, resolution: "inferred" })) },
    { ...original, calls: original.calls.map((call) => ({ ...call, targets: call.targets.map((target) => ({ ...target, filePath: "src/other-helper.ts" })) })) },
  ]) assert.notEqual(fingerprintExplanation(original), fingerprintExplanation(modified));
  const large = { ...original, source: "x".repeat(15_000) };
  assert.notEqual(fingerprintExplanation(large), fingerprintExplanation({ ...large, source: large.source + "y" }));
});

test("newly extracted JS decorator facts invalidate old explanations without invalidating undecorated methods", () => {
  const original = input();
  assert.equal(fingerprintExplanation(original), fingerprintExplanation({ ...original, symbol: { ...original.symbol, decorators: [] } }));
  const decorated = { ...original, symbol: { ...original.symbol, decorators: ['@Get("items")'] } };
  assert.notEqual(fingerprintExplanation(original), fingerprintExplanation(decorated));
  assert.notEqual(fingerprintExplanation(decorated), fingerprintExplanation({ ...decorated, symbol: { ...decorated.symbol, decorators: ['@Post("items")'] } }));
});

test("candidate target ordering is stable and configuration identities remain separate", () => {
  const original = input();
  original.calls[0].targets.push({ ...original.calls[0].targets[0], filePath: "src/second.ts" });
  const reversed = input(); reversed.calls[0].targets = [...original.calls[0].targets].reverse();
  const hash = fingerprintExplanation(original);
  assert.equal(hash, fingerprintExplanation(reversed));
  assert.equal(explanationContentKey("config-a", hash), `config-a:content-v1:${hash}`);
  assert.equal(storedExplanationFingerprint(explanationContentKey("config-a", hash)), hash);
  assert.equal(explanationMatchesConfig(explanationContentKey("config-a", hash), "config-a"), true);
  assert.equal(explanationMatchesConfig(explanationContentKey("config-a", hash), "config-b"), false);
  assert.equal(explanationMatchesConfig("config-a", "config-a"), true);
  assert.equal(explanationMatchesConfig("config-a:content-v1:broken", "config-a"), false);
});
