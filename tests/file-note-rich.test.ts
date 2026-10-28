import assert from "node:assert/strict";
import { test } from "node:test";
import { captureNoteLayout, encodeNoteLayout, decodeNoteLayout, notePasteWarning, safeNoteStyle } from "../src/lib/file-note-rich.ts";

test("HTML grids and cards preserve rows, columns, colors and text without scripts or positioning", () => {
  const nodes = captureNoteLayout('<div style="display:grid;grid-template-columns:repeat(12, minmax(0, 1fr));gap:2px;position:fixed"><div style="background:#fae49a" onclick="bad()">🌻</div><div>🌵</div><script>bad()</script></div>');
  assert.ok(nodes);
  assert.deepEqual(decodeNoteLayout(encodeNoteLayout(nodes)), nodes);
  const serialized = JSON.stringify(nodes);
  assert.match(serialized, /gridTemplateColumns/); assert.match(serialized, /#fae49a/);
  assert.doesNotMatch(serialized, /onclick|bad\(\)|fixed/);
});
test("plain lossy output is diagnosed, never silently invented as a grid or table", () => {
  assert.match(notePasteWarning(Array(12).fill("🌻").join("\n\n")), /丢失/);
  assert.match(notePasteWarning(Array(4).fill("|   |\n| - |\n\n单元格").join("\n\n")), /丢失/);
  assert.equal(captureNoteLayout("<p>普通段落</p>"), null);
  assert.equal(decodeNoteLayout(encodeNoteLayout([{ tag: "script", style: {}, attrs: {}, children: ["bad()"] }])), null);
});

test("browser-serialized flex flow preserves nested card direction and wrapping", () => {
  assert.deepEqual(safeNoteStyle("flex-flow: column wrap; position:fixed"), { flexDirection: "column", flexWrap: "wrap" });
});
