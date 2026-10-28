import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeFileNoteMath, faviconCitation, recoverPythonLines } from "../src/lib/file-note-rendering.ts";

// Compile the actual renderer for Node SSR; only CSS imports are omitted.
const parent = resolve(".next"); await mkdir(parent, { recursive: true });
const temp = await mkdtemp(join(parent, "note-render-test-"));
after(async () => { assert.equal(dirname(temp), parent); await rm(temp, { recursive: true, force: true }); });
async function compile(name) {
  const source = (await readFile(`src/components/${name}.tsx`, "utf8")).replace(/^import ["'][^"']+\.css["'];?\s*$/gm, "");
  const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  await writeFile(join(temp, `${name}.mjs`), js.replace(/(["'])\.\/(FileNoteCodeBlock|FileNoteMedia)\1/g, '"./$2.mjs"').replace(/(["'])@\/lib\/([^"']+)\1/g, (_all, _quote, file) => JSON.stringify(pathToFileURL(resolve(`src/lib/${file}.ts`)).href)));
}
await compile("FileNoteMedia");
await compile("FileNoteCodeBlock");
await compile("FileNoteMarkdown");
const { default: Markdown } = await import(pathToFileURL(join(temp, "FileNoteMarkdown.mjs")).href);
const fixture = await readFile("tests/fixtures/file-note-rendering.md", "utf8");
const render = (text) => renderToStaticMarkup(React.createElement(Markdown, { text }));

test("pasted double-escaped display math renders through KaTeX", () => {
  assert.match(render(fixture), /class="katex/);
});
test("favicon links become a source chip, and actual Markdown images render", () => {
  const html = render(fixture);
  assert.match(html, /<img[^>]+favicons/);
  assert.match(html, /<img[^>]+route\.png/);
  assert.match(html, /The Farmer Was Replaced Wiki/);
  const nested = render('1. 规则\n\n   [image](https://www.google.com/s2/favicons?domain=https://thefarmerwasreplaced.com&sz=32)\n\n   向日葵代码\n\n   +1');
  assert.match(nested, /<img[^>]+favicons/);
});
test("code blocks expose language, copy and explicit collapsed-code recovery", () => {
  const html = render(fixture);
  assert.match(html, /复制代码/);
  assert.match(html, /Python/);
  assert.match(html, /尝试恢复换行/);
  assert.match(html, /hljs-keyword/);
  const mislabelled = render('```shell\n# 耕地if get_ground_type() != Grounds.Soil:    till()\n```');
  assert.match(mislabelled, /Python/); assert.match(mislabelled, /尝试恢复换行/);
});

test("single and double escaped math work, while inline code, long/tilde/unclosed fences stay literal", () => {
  const expressions = [String.raw`\[x^2\]`, String.raw`\\[x^2\\]`, String.raw`\(x^2\)`, String.raw`\\(x^2\\)`];
  for (const expression of expressions) assert.match(render(expression), /class="katex/);
  const protectedText = String.raw`\[leave\]`;
  for (const fence of ["```", "````", "~~~"]) {
    const code = `${fence}text\n${protectedText}\n${fence}`;
    assert.equal(normalizeFileNoteMath(code), code);
    assert.doesNotMatch(render(code), /class="katex/);
    assert.equal(normalizeFileNoteMath(`${fence}\n${protectedText}`), `${fence}\n${protectedText}`);
  }
  assert.equal(normalizeFileNoteMath('`' + protectedText + '`'), '`' + protectedText + '`');
});

test("recovery is optional, keeps string contents and identifiers, and leaves normal multiline code alone", () => {
  const source = 'result = step(direction)if result == -1:    return -1eaten += result';
  const recovered = recoverPythonLines(source);
  assert.match(recovered, /step\(direction\)\nif/);
  assert.match(recovered, /return -1\neaten/);
  assert.doesNotMatch(recovered, /e\na\nt/);
  const withString = 'def f():    return "x    yif z"';
  assert.match(recoverPythonLines(withString), /"x    yif z"/);
  const normal = 'def f():\n    x = 1\n    return x';
  assert.equal(recoverPythonLines(normal), normal);
});

test("notes, formulas and highlighted code cannot mount arbitrary HTML or unsafe source URLs", () => {
  const html = render('<script>alert(1)</script>\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n[x](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  assert.equal(faviconCitation("javascript:alert(1)"), null);
  assert.equal(faviconCitation("https://example.com/favicon.ico?domain=javascript:alert(1)"), null);
  assert.equal(faviconCitation("https://user:password@example.com/favicon.ico"), null);
  assert.equal(faviconCitation("https://www.google.com/s2/favicons?domain=https://github.com\\&sz=32").href, "https://github.com/");
});
