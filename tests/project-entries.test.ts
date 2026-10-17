import assert from "node:assert/strict";
import { test } from "node:test";
import { identifyProjectEntries, type EntryFile, type EntrySymbol } from "../src/lib/analysis/project-entries.ts";

const file = (id: number, path: string, isTest = false): EntryFile => ({ id, path, isTest });
const symbol = (id: number, fileId: number, name: string, extra: Partial<EntrySymbol> = {}): EntrySymbol => ({
  id, fileId, name, qualifiedName: name, parentId: null, kind: "function", startLine: id, isTest: false,
  signature: `function ${name}()`, decorators: [], ...extra,
});

test("framework entries include default pages and exported HTTP handlers, excluding helpers and tests", () => {
  const result = identifyProjectEntries([
    file(1, "src/app/(shop)/page.tsx"), file(2, "src/app/api/products/route.ts"), file(3, "src/app/layout.tsx"),
    file(4, "src/components/page.tsx"), file(5, "tests/app/page.tsx"), file(6, "src/pages/api/items.ts"),
  ], [
    symbol(1, 1, "Home", { signature: "export default function Home()" }),
    symbol(2, 1, "helper", { signature: "export function helper()" }),
    symbol(3, 2, "GET", { signature: "export async function GET()" }),
    symbol(4, 2, "POST", { signature: "export const POST = async ()" }),
    symbol(5, 2, "DELETE"), // A local function with an HTTP name is not a handler export.
    symbol(6, 3, "Layout", { signature: "export default function Layout()" }),
    symbol(7, 4, "Widget", { signature: "export default function Widget()" }),
    symbol(8, 5, "FakePage", { signature: "export default function FakePage()" }),
    symbol(9, 6, "handler", { signature: "export default function handler()" }),
  ], new Set());
  assert.deepEqual(result.groups.find((group) => group.id === "pages")?.entries.map((entry) => entry.symbol.id), [1, 6]);
  assert.deepEqual(result.groups.find((group) => group.id === "api")?.entries.map((entry) => entry.symbol.id), [3, 4, 9]);
  assert.equal(result.entryCount, 5);
  assert.ok(result.groups.every((group) => group.id !== "candidates"));
  assert.ok(result.groups.flatMap((group) => group.entries).every((entry) => entry.confidence === "inferred" && entry.reason));
});

test("decorated Python routes and startup conventions preserve their evidence and confidence", () => {
  const result = identifyProjectEntries([file(1, "app.py"), file(2, "src\\main.ts"), file(3, "middleware.ts")], [
    symbol(1, 1, "list_items", { decorators: ['@router.get("/items")'] }),
    symbol(2, 1, "main"), symbol(3, 2, "bootstrap"),
    symbol(4, 3, "middleware", { signature: "export function middleware()" }),
  ], new Set([2, 3]));
  assert.equal(result.entryCount, 4);
  assert.match(result.groups[0].entries[0].reason, /router.get/);
  const startup = result.groups.find((group) => group.id === "startup")!.entries;
  assert.equal(startup.find((entry) => entry.symbol.id === 2)?.confidence, "heuristic");
  assert.equal(startup.find((entry) => entry.symbol.id === 3)?.symbol.filePath, "src/main.ts");
  assert.equal(startup.find((entry) => entry.symbol.id === 4)?.confidence, "inferred");
});

test("fallback exposes uncalled top-level functions as candidates without inventing a real root", () => {
  const result = identifyProjectEntries([file(1, "src/library.ts"), file(2, "test_helper.ts", true)], [
    symbol(1, 1, "publicApi"), symbol(2, 1, "calledHelper"), symbol(3, 1, "nested", { parentId: 1 }),
    symbol(4, 1, "Thing", { kind: "class" }), symbol(5, 2, "testFixture"), symbol(6, 99, "missingFile"),
    symbol(7, 1, "testFlag", { isTest: true }),
  ], new Set([2]));
  assert.equal(result.entryCount, 1);
  assert.equal(result.groups[0].id, "candidates");
  assert.equal(result.groups[0].entries[0].confidence, "heuristic");
  assert.match(result.groups[0].entries[0].reason, /未使用/);
  assert.deepEqual(identifyProjectEntries([], [], new Set()), { groups: [], entryCount: 0 });
});
