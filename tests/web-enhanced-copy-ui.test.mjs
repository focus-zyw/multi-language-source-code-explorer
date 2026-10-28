// RUN_WEB_COPY_UI=1; production build and a full Chromium with Playwright required.
// All source, browser profile, DB and servers belong to this test. No real AI calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

test("real extension: activeTab injection, rich clipboard, editable note, local media and reload", { skip: process.env.RUN_WEB_COPY_UI !== "1", timeout: 180000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-web-copy-"));
  const marker = join(temp, "file-notes-ui.json"), done = join(temp, "file-notes-ui.done");
  let fixture, context, server;
  let fixtureOutput = "";
  try {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
    const html = (await readFile("tests/fixtures/web-enhanced-copy.html", "utf8")).replace("<!-- CELLS -->", Array.from({ length: 144 }, (_, i) => `<div style="background:${i < 48 ? "#f9e39b" : "#efc18c"}">${i < 48 ? "🌻" : "🎃"}</div>`).join(""));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=", "base64");
    server = createServer((request, response) => {
      response.setHeader("content-type", request.url === "/pixel.png" ? "image/png" : "text/html;charset=utf-8");
      response.end(request.url === "/pixel.png" ? png : html);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const sourceBase = `http://localhost:${server.address().port}`;
    context = await chromium.launchPersistentContext(join(temp, "browser"), {
      headless: true, channel: "chromium", viewport: { width: 1500, height: 1000 },
      ...(process.env.WEB_COPY_CHROMIUM ? { executablePath: process.env.WEB_COPY_CHROMIUM } : {}),
      ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging"],
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const extension = await cdp.send("Extensions.loadUnpacked", { path: resolve("tools/web-enhanced-copy") });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: sourceBase });
    await page.goto(sourceBase);
    const targets = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const tabTarget = targets.targetInfos.find((target) => target.url === `${sourceBase}/`);
    assert.ok(tabTarget);
    // This is the browser action itself: it grants activeTab without broad host permissions.
    await cdp.send("Extensions.triggerAction", { id: extension.id, targetId: tabTarget.targetId });
    // Use the shipped popup document in a test tab; the source tab stays active.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extension.id}/popup.html`);
    await page.bringToFront();
    await popup.evaluate(() => document.querySelector("#replies").click());
    await page.getByRole("button", { name: "增强复制", exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "增强复制", exact: true }).count(), 2);
    await popup.evaluate(() => document.querySelector("#replies").click());
    await page.getByRole("button", { name: "增强复制", exact: true }).first().click();
    await page.getByRole("status").filter({ hasText: /^已复制：/ }).waitFor();
    const clip = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return { html: await (await item.getType("text/html")).text(), plain: await (await item.getType("text/plain")).text() };
    });
    clip.plain = clip.plain.replace(/\r\n/g, "\n");
    assert.match(clip.html, /data-code-atlas-copy="1"/);
    assert.match(clip.html, /repeat\(12, minmax\(0(?:px)?, 1fr\)\)/);
    assert.match(clip.html, /data:image\/png;base64,/);
    assert.match(clip.plain, /```python\n# 将地面变成耕地\nif get_ground_type/);
    assert.match(clip.plain, /\$\$\nB = L\^2\n\$\$/);
    assert.match(clip.plain, /\| 代码 \| 作用 \|/);
    assert.doesNotMatch(clip.html, /隐藏内容不能|用户的问题不能|原网页复制按钮不能|<svg|<button|<script/);
    assert.match(await page.getByRole("status").innerText(), /2 个布局/);

    // Safety failures must leave the previous clipboard intact.
    await page.locator("#sunflower").evaluate((node) => node.setAttribute("aria-busy", "true"));
    await page.getByRole("button", { name: "增强复制", exact: true }).first().click();
    await page.getByRole("status").filter({ hasText: /回复仍在生成/ }).waitFor();
    await page.locator("#sunflower").evaluate((node) => node.removeAttribute("aria-busy"));
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), clip.plain);

    const fixtureEnv = { ...process.env, RUN_FILE_NOTES_E2E: "1", RUN_FILE_NOTES_UI: "1", FILE_NOTES_UI_DIR: temp };
    delete fixtureEnv.NODE_TEST_CONTEXT;
    fixture = spawn(process.execPath, ["--test", "tests/file-notes.integration.test.mjs"], { env: fixtureEnv, stdio: "pipe", windowsHide: true });
    fixture.stdout.on("data", (chunk) => { fixtureOutput += chunk; }); fixture.stderr.on("data", (chunk) => { fixtureOutput += chunk; });
    let info;
    for (let i = 0; i < 180; i++) {
      try { info = JSON.parse(await readFile(marker, "utf8")); break; } catch {}
      if (fixture.exitCode !== null) break;
      await delay(200);
    }
    assert.ok(info, fixtureOutput);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: info.base });
    const note = await context.newPage(); note.on("pageerror", (error) => errors.push(error.message));
    await note.goto(`${info.base}/p/${info.projectId}?f=${info.fileId}`);
    const editor = note.getByRole("textbox", { name: "文件笔记正文" });
    await editor.fill("已有笔记\n\n");
    await editor.press("Control+End"); await editor.press("Control+V");
    await note.getByText("正在保存笔记附件…", { exact: true }).waitFor({ state: "hidden" });
    await note.getByRole("button", { name: "保存笔记", exact: true }).waitFor();
    await note.waitForFunction(() => document.querySelector('textarea[aria-label="文件笔记正文"]')?.value.includes("向日葵种植笔记"));
    const body = await editor.inputValue();
    assert.match(body, /^已有笔记/);
    assert.match(body, /\$\$\nB = L\^2\n\$\$/);
    assert.match(body, /```python\n# 将地面变成耕地/);
    assert.equal((body.match(/!\[富文本布局\]/g) ?? []).length, 2);
    assert.doesNotMatch(body, /data:image|data:application/);
    await note.getByRole("button", { name: "保存笔记", exact: true }).click();
    await note.getByRole("status").filter({ hasText: /^已保存$/ }).waitFor();
    await note.reload();
    await note.waitForFunction(() => document.querySelector('textarea[aria-label="文件笔记正文"]')?.value.startsWith("已有笔记"));
    assert.equal(await editor.inputValue(), body);
    await note.locator("details > summary").filter({ hasText: "预览" }).click();
    const grid = note.locator('.file-note-rich [style*="grid-template-columns"]').first();
    await grid.waitFor();
    assert.equal(await grid.locator(":scope > div").count(), 144);
    assert.equal(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), 12);
    const cards = note.locator('.file-note-rich [style*="display: flex"]').filter({ hasText: "第 1 株" }).filter({ hasText: "优先收割" });
    assert.equal(await cards.first().locator(":scope > div").count(), 4);
    assert.equal(await cards.first().locator(":scope > div").first().evaluate((node) => getComputedStyle(node).flexDirection), "column");
    assert.equal(await note.locator(".katex").count() > 0, true);
    assert.equal(await note.locator(".file-note-markdown table tr").count(), 7);
    assert.equal(await note.locator(".file-note-markdown table tr").first().locator("th").count(), 2);
    const image = note.getByRole("img", { name: "本地测试图片", exact: true });
    await image.waitFor();
    await image.scrollIntoViewIfNeeded();
    assert.match(await image.getAttribute("src"), /\/note-media\//);
    await note.waitForFunction(() => Array.from(document.images).some((node) => node.alt === "本地测试图片" && node.complete && node.naturalWidth > 0));
    if (process.env.WEB_COPY_SCREENSHOT) await note.screenshot({ path: process.env.WEB_COPY_SCREENSHOT, fullPage: true });

    // Appending a copy must still leave ordinary prose editable and enforce the final budget.
    await editor.fill(body + "\n\n可继续编辑的追加内容");
    await note.getByRole("button", { name: "保存笔记", exact: true }).click();
    await note.getByRole("status").filter({ hasText: /^已保存$/ }).waitFor();
    await note.reload();
    await note.waitForFunction(() => document.querySelector('textarea[aria-label="文件笔记正文"]')?.value.includes("可继续编辑的追加内容"));

    // Generic region selection is usable even without the ChatGPT adapter.
    await page.bringToFront();
    await page.getByRole("button", { name: "选择区域", exact: true }).click();
    await page.locator("#second p").hover(); await page.locator("#second p").click();
    await page.getByRole("button", { name: "复制所选区域", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /^已复制：/ }).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /第二条独立回复/);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(await page.locator("[data-code-atlas-copy-ui]").count(), 0);
    assert.deepEqual(errors, []);
    await writeFile(done, "done");
    const exit = fixture.exitCode ?? (await once(fixture, "close"))[0]; assert.equal(exit, 0, fixtureOutput);
  } finally {
    if (context) await context.close();
    if (server) await new Promise((r) => server.close(r));
    if (fixture && fixture.exitCode === null) { await writeFile(done, "done"); await Promise.race([once(fixture, "close"), delay(8000)]); }
    if (fixture && fixture.exitCode === null) fixture.kill();
    assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("atlas-web-copy-"));
    await rm(temp, { recursive: true, force: true });
  }
});
