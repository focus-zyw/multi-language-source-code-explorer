import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDependencies, buildLearning, dependencyCycles, type InsightSymbol } from "../src/lib/project-insights.ts";
import type { FileImportInfo } from "../src/lib/shared.ts";

const imported = (path: string | null, guess = false, kind: FileImportInfo["kind"] = "project"): FileImportInfo => ({ resolvedPath: path, guess, kind, specifier: path ?? "pkg", line: 2, names: [], reason: null });
const file = (id: number, path: string, imports: FileImportInfo[] = []) => ({ id, path, language: "typescript", isTest: false, symbolId: id, imports });

test("dependencies preserve uncertain edges and boundaries; only certain cycles count by default", () => {
  const result = buildDependencies([file(1, "a.ts", [imported("b.ts"), imported("b.ts"), imported(null, false, "external")]),
    file(2, "b.ts", [imported("a.ts", true), imported("missing.ts")]), file(3, "empty.ts")]);
  assert.equal(result.edges.length, 2);
  assert.equal(result.edges[0].count, 2);
  assert.deepEqual(result.edges[0].lines, [2]);
  assert.equal(result.boundaries[0].kind, "external");
  assert.equal(result.boundaries[1].kind, "unresolved");
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(result.possibleCycles, [[1, 2]]);
  assert.equal(result.files[2].symbolId, 3);
  assert.equal("imports" in result.files[0], false);
});

test("cycle groups handle self imports, disconnected components and long chains without recursion", () => {
  const result = buildDependencies([file(1, "a", [imported("a")]), file(2, "b", [imported("c")]), file(3, "c", [imported("b")]), file(4, "d")]);
  assert.deepEqual(result.cycles, [[2, 3], [1]]);
  const ids = Array.from({ length: 15000 }, (_, i) => i);
  assert.deepEqual(dependencyCycles(ids, ids.slice(1).map((id) => ({ id: String(id), source: id - 1, target: id, inferred: false, count: 1, lines: [], specifiers: [] }))), []);
});

test("truncated dependency output explicitly limits cycle conclusions", () => {
  const result = buildDependencies([file(1, "a", [imported("b"), imported("c")]), file(2, "b", [imported("a")]), file(3, "c")], 1);
  assert.equal(result.truncated, true); assert.equal(result.edges.length, 1); assert.deepEqual(result.cycles, []);
});

test("learning ranks real methods, separates confidence and counts distinct caller methods", () => {
  const symbol = (id: number, patch: Partial<InsightSymbol> = {}): InsightSymbol => ({ id, fileId: 1, parentId: null, name: `s${id}`, qualifiedName: `s${id}`, kind: "function", startLine: id, isTest: false, complexity: id, loc: id * 3, decorators: [], bases: [], ...patch });
  const result = buildLearning([file(1, "main.ts"), { ...file(2, "test.ts"), isTest: true }], [symbol(1), symbol(2), symbol(3, { kind: "property" }), symbol(4, { isTest: true }), symbol(5, { fileId: 2 })],
    [{ target: 1, owner: 9, confidence: "exact" }, { target: 1, owner: 9, confidence: "exact" }, { target: 1, owner: 10, confidence: "inferred" }, { target: 1, owner: 11, confidence: "heuristic" }]);
  assert.equal(result.methodCount, 2);
  assert.deepEqual(result.complex.map((item) => item.id), [2, 1]);
  assert.equal(result.referenced[0].exactCallers, 1);
  assert.equal(result.referenced[0].inferredCallers, 1);
  assert.equal(result.referenced[0].candidateCallers, 1);
  assert.equal(result.distribution.reduce((sum, bucket) => sum + bucket.count, 0), 2);
});
