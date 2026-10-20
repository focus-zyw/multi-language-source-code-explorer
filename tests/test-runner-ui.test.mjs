// Optional browser check. Requires a production build and an available playwright package.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("browser: consent, execution, navigation continuity, stop and coverage", { skip: process.env.RUN_TEST_RUNNER_UI !== "1", timeout: 120000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-runner-ui-"));
  const marker = join(temp, "fixture.json");
  let fixture, browser;
  try {
    let output = "";
    const fixtureEnv = { ...process.env, RUN_TEST_RUNNER_E2E: "1", TEST_RUNNER_UI_PATH: marker };
    delete fixtureEnv.NODE_TEST_CONTEXT;
    fixture = spawn(process.execPath, ["--test", "tests/test-runner.integration.test.mjs"], { env: fixtureEnv, stdio: "pipe", windowsHide: true });
    fixture.stdout.on("data", (s) => { output += s; }); fixture.stderr.on("data", (s) => { output += s; });
    let info;
    for (let i = 0; i < 150; i++) { try { info = JSON.parse(await readFile(marker, "utf8")); break; } catch {} if (fixture.exitCode !== null) break; await delay(200); }
    assert.ok(info, output);
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${info.base}/p/${info.projectId}?s=${info.symbolId}`);
    await page.getByRole("button", { name: /关联测试/ }).click();
    const panel = page.getByRole("region", { name: "测试执行" });
    await panel.getByLabel("项目测试命令").waitFor();
    const run = panel.getByRole("button", { name: "运行项目测试" });
    assert.equal(await run.isEnabled(), false);
    await panel.getByLabel("项目测试命令").selectOption("test");
    await panel.getByRole("checkbox", { name: /我信任该项目/ }).check();
    await run.click();
    await panel.getByRole("button", { name: "停止测试" }).waitFor();
    await page.getByRole("button", { name: "讲解", exact: true }).click();
    await page.getByRole("button", { name: /关联测试/ }).click();
    await panel.getByText(/运行成功 ·/).waitFor();
    await panel.getByRole("checkbox", { name: /我信任该项目/ }).check(); await run.click();
    await panel.getByRole("button", { name: "停止测试" }).click();
    await panel.getByText(/已停止 ·/).waitFor();
    await panel.getByLabel("项目测试命令").selectOption("test:coverage");
    await panel.getByRole("checkbox", { name: /收集本次行覆盖率/ }).check();
    await panel.getByRole("checkbox", { name: /我信任该项目/ }).check(); await run.click();
    await panel.getByLabel("当前方法行覆盖率").waitFor();
    assert.match(await panel.getByLabel("当前方法行覆盖率").innerText(), /命中 2/);
    assert.deepEqual(errors, []);
    if (process.env.TEST_RUNNER_SCREENSHOT) await page.screenshot({ path: process.env.TEST_RUNNER_SCREENSHOT, fullPage: true });
    await rm(marker);
    assert.equal((await once(fixture, "close"))[0], 0, output);
  } finally {
    if (browser) await browser.close();
    await rm(marker, { force: true });
    if (fixture && fixture.exitCode === null) await Promise.race([once(fixture, "close"), delay(10000)]);
    if (fixture && fixture.exitCode === null) fixture.kill();
    await rm(temp, { recursive: true, force: true });
  }
});
