import assert from "node:assert/strict";
import { test } from "node:test";
import { routeHint } from "../src/lib/analysis/route-hints.ts";
import { identifyProjectEntries } from "../src/lib/analysis/project-entries.ts";
import { parseSource } from "../src/lib/analysis/treesitter.ts";
import { pluginForPath } from "../src/lib/analysis/registry.ts";

test("Spring combines literal prefixes and multiple paths while preserving method evidence", () => {
  const hint = routeHint(['@RequestMapping(value={"/a", "/{id}"}, method={RequestMethod.GET, RequestMethod.POST})'], "Controller.java", ['@RequestMapping("/api")'])!;
  assert.deepEqual(hint.methods, ["GET", "POST"]);
  assert.deepEqual(hint.paths, ["/api/a", "/api/{id}"]);
  assert.equal(hint.partial, false);
  assert.match(hint.note, /未验证/);
});

test("Python and Nest-style routes retain limits and never evaluate path expressions", () => {
  assert.deepEqual(routeHint(['@router.route("/items", methods=["GET", "POST"])'], "app.py")?.methods, ["GET", "POST"]);
  assert.match(routeHint(['@router.get("/items")'], "app.py")!.note, /未合并/);
  assert.deepEqual(routeHint(['@Get(":id")'], "controller.ts", ['@Controller("items")'])?.paths, ["/items/:id"]);
  const dynamic = routeHint(['@router.get(PREFIX + "/items")'], "app.py")!;
  assert.deepEqual(dynamic.paths, []); assert.equal(dynamic.partial, true);
  assert.deepEqual(routeHint(['@router.get("/items" + suffix)'], "app.py")!.paths, []);
  assert.deepEqual(routeHint(['@GetMapping("/items")'], "C.java", ['@RequestMapping(PREFIX)'])!.partial, true);
  assert.equal(routeHint(["@cache.memoize()"], "app.py"), null);
});

test("oversized literal products are bounded and incomplete fragments stay visible", () => {
  const hint = routeHint([`@GetMapping(value={${Array.from({ length: 33 }, (_, i) => `"/${i}"`).join(",")}})`], "C.java")!;
  assert.equal(hint.partial, true); assert.equal(hint.paths.length, 0);
  assert.equal(routeHint(['@router.get("/incomplete"'], "app.py")!.partial, true);
});

test("real extracted Java, Python and TypeScript route annotations feed navigation without executing sources", async () => {
  for (const [path, source, expected] of [
    ["Controller.java", '@RequestMapping("/api") class Controller { @GetMapping("/items") public String items() { return "ok"; } }', "/api/items"],
    ["app.py", '@router.get("/items")\ndef items():\n  return 1\n', "/items"],
    ["controller.ts", '@Controller("api")\nexport class Controller { @Get("items") items() { return 1; } }', "/api/items"],
    ["Controller.cs", '[Route("/api")]\nclass Controller { [HttpGet("/items")] public string Items() { return "ok"; } }', "/api/items"],
  ]) {
    const plugin = pluginForPath(path)!;
    const tree = await parseSource(plugin.grammar, source); assert.ok(tree);
    try {
      const result = plugin.plugin.extract(tree.rootNode, source, path);
      if (path.endsWith(".ts")) {
        const method = result.symbols.find((symbol) => symbol.kind === "method")!;
        assert.ok(source.slice(method.startIndex, method.endIndex).startsWith('@Get("items")'));
      }
      const symbols = result.symbols.map((symbol) => ({ ...symbol, id: symbol.localId + 1, fileId: 1, parentId: symbol.parentLocalId === null ? null : symbol.parentLocalId + 1 }));
      const entries = identifyProjectEntries([{ id: 1, path, isTest: false }], symbols, new Set());
      const api = entries.groups.find((group) => group.id === "api");
      assert.ok(api?.entries.length, path);
      assert.ok(api.entries[0].reason.includes(expected), `${path}: ${api.entries[0].reason}`);
      assert.equal(api.entries[0].confidence, "inferred");
    } finally { tree.delete(); }
  }
});

test("sibling decorators do not bleed into the next TypeScript method", async () => {
  const source = 'class C {\n @Get("/one")\n one() { return 1; }\n two() { return 2; }\n}';
  const plugin = pluginForPath("C.ts")!, tree = await parseSource(plugin.grammar, source); assert.ok(tree);
  try {
    const symbols = plugin.plugin.extract(tree.rootNode, source, "C.ts").symbols;
    assert.deepEqual(symbols.find((symbol) => symbol.name === "one")!.decorators, ['@Get("/one")']);
    assert.deepEqual(symbols.find((symbol) => symbol.name === "two")!.decorators, []);
  } finally { tree.delete(); }
});
