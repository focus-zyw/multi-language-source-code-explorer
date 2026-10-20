import assert from "node:assert/strict";
import { test } from "node:test";
import { readSymbolSearch, searchSymbols, SearchInputError, type SearchSymbol } from "../src/lib/symbol-search.ts";

const file = { id: 1, path: "src/api/service.ts", language: "typescript", isTest: false };
const symbol = (id: number, patch: Partial<SearchSymbol> = {}): SearchSymbol => ({ id, fileId: 1, kind: "class", qualifiedName: `Service${id}`, startLine: id, isTest: false, decorators: ["@Injectable()"], bases: ["BaseService<T>"], docstring: null, ...patch });
const query = (value = "") => readSymbolSearch(new URLSearchParams(value));

test("structured search combines recorded fields and does not invent interface or decorator matches", () => {
  const rows = [symbol(1), symbol(2, { decorators: [], bases: [] }), symbol(3, { fileId: 99 })];
  assert.deepEqual(searchSymbols([file], rows, query("q=service&kind=class&language=typescript&decorator=Injectable&base=Base&path=src/api")).items.map((item) => item.id), [1]);
  assert.equal(searchSymbols([file], rows, query("base=UnknownInterface")).total, 0);
  assert.equal(searchSymbols([file], rows, query()).total, 2);
});

test("deprecated documentation and annotation markers are searchable independently of decorator filters", () => {
  const rows = [symbol(1, { docstring: "/** @deprecated use newOne */", decorators: [] }), symbol(2, { decorators: ["@java.lang.Deprecated"] }), symbol(3)];
  assert.deepEqual(searchSymbols([file], rows, query("deprecated=1")).items.map((item) => item.id), [1, 2]);
  assert.equal(searchSymbols([file], rows, query("deprecated=1&decorator=Deprecated")).total, 1);
});

test("search pages deterministically and respects both symbol and file test status", () => {
  const rows = Array.from({ length: 85 }, (_, id) => symbol(id));
  assert.equal(searchSymbols([file], rows, query()).items.length, 40);
  assert.equal(searchSymbols([file], rows, query("page=2")).items.length, 5);
  assert.equal(searchSymbols([{ ...file, isTest: true }], rows, query("scope=source")).total, 0);
  assert.equal(searchSymbols([file], [symbol(1, { isTest: true })], query("scope=tests")).total, 1);
});

test("search rejects unbounded input and invalid filters before querying", () => {
  for (const input of ["kind=interface", "language=unknown", "scope=unknown", "page=-1", "page=1e2", "deprecated=yes", `q=${"x".repeat(201)}`]) assert.throws(() => query(input), SearchInputError);
});
