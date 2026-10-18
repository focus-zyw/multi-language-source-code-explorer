import assert from "node:assert/strict";
import { test } from "node:test";
import { isJsonDependencyLock, structurePageSize, structurePageItems } from "../src/lib/structure-browsing.ts";

test("wide structures show only a page, with more items available and selected descendants reachable", () => {
  const children = Array.from({ length: 300 }, (_, i) => ({ id: i + 1 }));
  assert.equal(structurePageSize(children), 50);
  assert.equal(structurePageSize(children, 100), 100);
  const selected = structurePageItems(children, 50, 241);
  assert.equal(selected.length, 51);
  assert.equal(selected.at(-1)?.id, 241);
  assert.equal(structurePageItems(children, 50, 20).length, 50);
  assert.equal(structurePageSize(children, 500), 300);
  assert.equal(structurePageSize([], 50), 0);
});

test("lock policy matches generated dependency locks without excluding normal configuration", () => {
  for (const path of ["package-lock.json", "nested/npm-shrinkwrap.json", "a\\PACKAGE-LOCK.JSON"]) assert.equal(isJsonDependencyLock(path), true);
  for (const path of ["package.json", "data.json", "my-package-lock.json"]) assert.equal(isJsonDependencyLock(path), false);
});
