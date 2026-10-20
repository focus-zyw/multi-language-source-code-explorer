import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("real Python plugin separates same-name methods using their definition position", () => {
  const result = spawnSync(process.platform === "win32" ? "python.exe" : "python3", ["-B", "tests/support/trace-plugin-check.py", "resources/pytest/atlas_trace_plugin.py"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /identity OK/);
});
