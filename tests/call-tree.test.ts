import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCallTree, type CallTreeLoad } from "../src/lib/analysis/call-tree.ts";
import type { CallTreeBranch, CallTreeSymbol } from "../src/lib/api-types.ts";

const symbol = (id: number): CallTreeSymbol => ({ id, name: `method${id}`, kind: "function", filePath: "app.ts", line: id });
const branch = (refId: number, ids: number[], resolution: CallTreeBranch["resolution"] = "exact"): CallTreeBranch => ({
  refId, label: `call${refId}()`, line: refId, filePath: "app.ts", resolution, reason: "fixture",
  targets: ids.map((id) => ({ symbol: symbol(id), confidence: resolution, reason: "fixture" })),
});
const page = (id: number, branches: CallTreeBranch[], nextOffset: number | null = null): CallTreeLoad => ({ page: { symbol: symbol(id), direction: "outgoing", branches, nextOffset } });

test("lazy tree expands occurrences independently, detects path cycles and preserves repeated calls", () => {
  const pages = new Map([[1, page(1, [branch(10, [2]), branch(11, [2])])], [2, page(2, [branch(12, [1])])]]);
  const initial = buildCallTree(symbol(1), pages, new Set(["root"]));
  assert.equal(initial.nodes.length, 3);
  const first = initial.nodes[1].id;
  const second = initial.nodes[2].id;
  assert.notEqual(first, second);
  const expanded = buildCallTree(symbol(1), pages, new Set(["root", first]));
  assert.equal(expanded.nodes.length, 4);
  const cycle = expanded.nodes.find((node) => node.cycle);
  assert.equal(cycle?.symbol?.id, 1);
  assert.equal(cycle?.expandable, false);
  assert.equal(expanded.nodes.find((node) => node.id === second)?.expanded, false);
  assert.equal(buildCallTree(symbol(1), pages, new Set()).nodes.length, 1);
});

test("ambiguous candidates require explicit expansion and terminal calls retain reference metadata", () => {
  const pages = new Map([[1, page(1, [branch(10, [2, 3], "heuristic"), branch(11, [], "external"), branch(12, [], "unresolved")])]]);
  const initial = buildCallTree(symbol(1), pages, new Set(["root"]));
  assert.equal(initial.nodes.filter((node) => node.type === "symbol").length, 1);
  const candidates = initial.nodes.find((node) => node.type === "candidates")!;
  assert.equal(candidates.resolution, "heuristic");
  const expanded = buildCallTree(symbol(1), pages, new Set(["root", candidates.id]));
  assert.deepEqual(expanded.nodes.filter((node) => node.type === "symbol").map((node) => node.symbol!.id), [1, 2, 3]);
  const terminal = expanded.nodes.find((node) => node.type === "terminal")!;
  assert.equal(terminal.ownerId, 1);
  assert.equal(terminal.refId, 11);
  assert.equal(buildCallTree(symbol(1), pages, new Set(["root"]), false).nodes.length, 2);
});

test("loading, failures, pagination, empty leaves and rendering limits stay visible", () => {
  const pending = buildCallTree(symbol(1), new Map(), new Set(["root"]));
  assert.match(pending.nodes[1].label, /加载/);
  const error = buildCallTree(symbol(1), new Map([[1, { error: "offline" }]]), new Set(["root"]));
  assert.equal(error.nodes[1].error, "offline");
  assert.equal(error.nodes[1].ownerId, 1);
  const paginated = new Map([[1, { ...page(1, [branch(10, [])], 10), error: "offline" }]]);
  const more = buildCallTree(symbol(1), paginated, new Set(["root"]), false);
  assert.equal(more.nodes[1].type, "more");
  assert.equal(more.nodes[1].ownerId, 1);
  assert.equal(more.nodes[1].error, "offline");
  const empty = buildCallTree(symbol(1), new Map([[1, page(1, [])]]), new Set(["root"]));
  assert.match(empty.nodes[1].label, /没有记录/);
  const limited = buildCallTree(symbol(1), new Map([[1, page(1, [branch(10, [2]), branch(11, [3])])]]), new Set(["root"]), true, 2);
  assert.equal(limited.nodes.length, 2);
  assert.equal(limited.edges.length, 1);
  assert.equal(limited.truncated, true);
});

test("long paths stop at depth eight with a new-root hint", () => {
  const pages = new Map(Array.from({ length: 12 }, (_, index) => [index + 1, page(index + 1, [branch(index + 10, [index + 2])])]));
  const expanded = new Set<string>();
  let path = "root";
  for (let index = 0; index < 12; index++) { expanded.add(path); path += `/r${index + 10}/s${index + 2}`; }
  const tree = buildCallTree(symbol(1), pages, expanded);
  assert.equal(tree.nodes.length, 9);
  assert.equal(tree.nodes.at(-1)?.expandable, false);
  assert.match(tree.nodes.at(-1)?.reason ?? "", /新起点/);
});
