import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { test } from "node:test";

test("unpacked extension has only gesture-scoped permissions and executable local entry points", async () => {
  const folder = new URL("../tools/web-enhanced-copy/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", folder), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "clipboardWrite", "scripting"].sort());
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  const popup = await readFile(new URL(manifest.action.default_popup, folder), "utf8");
  assert.match(popup, /src="popup.js"/);
  for (const name of ["popup.js", "capture.js", "content.js"]) {
    const source = await readFile(new URL(name, folder), "utf8");
    assert.doesNotThrow(() => new Script(source, { filename: name }));
    assert.doesNotMatch(source, /\beval\s*\(|new Function\s*\(/);
  }
});
