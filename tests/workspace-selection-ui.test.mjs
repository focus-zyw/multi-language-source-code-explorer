// Optional real-browser check. Requires a production build and Playwright.
// Uses a dedicated temporary database, source project and server; no model calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

test("workspace keeps selection, analysis and background generation associated with their methods", { skip: process.env.RUN_WORKSPACE_SELECTION_UI !== "1", timeout: 120000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "atlas-selection-ui-"));
  let app, browser;
  const releases = [];
  try {
    const reserve = createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: pathToFileURL(join(temp, "app.db")).href, AI_AGENT_ENABLED: "false", AI_EXPLAIN_BACKEND: "api", AI_PROVIDER: "openai", AI_API_KEY: "fixture-key", AI_MODEL: "fixture", AI_BASE_URL: `http://127.0.0.1:${port}/fixture-only` };
    delete env.__NEXT_PROCESSED_ENV;
    const push = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "push"], { env, stdio: "pipe", windowsHide: true });
    let pushLog = ""; push.stdout.on("data", (chunk) => { pushLog += chunk; }); push.stderr.on("data", (chunk) => { pushLog += chunk; });
    assert.equal((await once(push, "close"))[0], 0, pushLog);
    let appLog = "";
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "pipe", windowsHide: true });
    app.stdout.on("data", (chunk) => { appLog += chunk; }); app.stderr.on("data", (chunk) => { appLog += chunk; });
    const base = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await delay(200); }
    assert.ok(ready, appLog);
    const root = join(temp, "source"); await mkdir(root);
    await writeFile(join(root, "main.ts"), "export function alpha(alphaValue: number) { return alphaValue; }\nexport function beta(betaValue: number) { return betaValue; }\nexport function gamma(gammaValue: number) { return gammaValue; }\nexport function delta(deltaValue: number) { return deltaValue; }\n");
    const response = await fetch(`${base}/api/projects/local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "import", path: root }) });
    const project = await response.json(); assert.ok(project.id, JSON.stringify(project));
    const tree = await (await fetch(`${base}/api/projects/${project.id}/tree`)).json();
    const alpha = tree.symbols.find((symbol) => symbol.name === "alpha");
    const beta = tree.symbols.find((symbol) => symbol.name === "beta");
    const gamma = tree.symbols.find((symbol) => symbol.name === "gamma");
    const delta = tree.symbols.find((symbol) => symbol.name === "delta");
    assert.ok(alpha && beta && gamma && delta);
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    // Simulate a transport that completes despite cancellation; only reads are affected.
    await page.addInitScript(() => {
      const original = window.fetch;
      window.__settledReads = {};
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (/\/symbols\/\d+(?:\/analysis)?$/.test(url) && (!init?.method || init.method === "GET")) {
          return original(input, { ...init, signal: undefined }).then((response) => {
            const json = response.json.bind(response);
            response.json = () => json().finally(() => {
              // Wait for the component's promise callbacks and React render after body consumption.
              setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
                window.__settledReads[url] = (window.__settledReads[url] ?? 0) + 1;
              })), 0);
            });
            return response;
          });
        }
        return original(input, init);
      };
    });
    await page.goto(`${base}/p/${project.id}?s=${alpha.id}`);
    const panel = page.getByRole("region", { name: "源码详情" });
    await panel.getByRole("heading", { name: "AI 讲解" }).waitFor();
    const hold = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      releases.push(release);
      return { promise, release };
    };
    const readCount = (url) => page.evaluate((key) => window.__settledReads[key] ?? 0, url);
    const settleRead = (url, previous) => page.waitForFunction(({ key, count }) => (window.__settledReads[key] ?? 0) > count, { key: url, count: previous });
    const betaGate = hold(), betaStarted = hold();
    let betaRequests = 0;
    await page.route(`**/api/projects/${project.id}/symbols/${beta.id}`, async (route) => {
      betaRequests++;
      if (betaRequests === 1) { betaStarted.release(); await betaGate.promise; await route.fulfill({ status: 503, json: { error: "测试详情失败" } }); }
      else await route.continue();
    });
    await page.locator(`#sym-${beta.id}`).click();
    await betaStarted.promise;
    assert.equal(await panel.getByRole("heading", { name: "AI 讲解" }).count(), 0, "上一个方法的讲解控件在新方法加载时仍可操作");
    for (const name of ["问答", "笔记", "讲解"]) {
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(await panel.getByRole("heading", { name: "alpha", exact: true }).count(), 0);
      assert.equal(await panel.getByRole("button", { name: "生成 AI 讲解" }).count(), 0);
    }
    betaGate.release();
    await panel.getByRole("alert").getByText("测试详情失败").waitFor();
    assert.equal(await panel.getByRole("heading", { name: "alpha", exact: true }).count(), 0);
    await panel.getByRole("button", { name: "重新加载" }).click();
    await panel.getByRole("heading", { name: "beta", exact: true }).waitFor();
    assert.equal(betaRequests, 2);

    // A later stale success must neither replace delta nor populate gamma's cache.
    const gammaGate = hold(), gammaStarted = hold();
    let gammaRequests = 0;
    await page.route(`**/api/projects/${project.id}/symbols/${gamma.id}`, async (route) => {
      gammaRequests++;
      if (gammaRequests === 1) { gammaStarted.release(); await gammaGate.promise; }
      await route.continue();
    });
    await page.locator(`#sym-${gamma.id}`).click(); await gammaStarted.promise;
    await page.locator(`#sym-${alpha.id}`).click();
    await panel.getByRole("heading", { name: "alpha", exact: true }).waitFor();
    await page.locator(`#sym-${delta.id}`).click();
    await panel.getByRole("heading", { name: "delta", exact: true }).waitFor();
    const gammaUrl = `/api/projects/${project.id}/symbols/${gamma.id}`;
    const gammaCount = await readCount(gammaUrl);
    gammaGate.release(); await settleRead(gammaUrl, gammaCount);
    assert.equal(await panel.getByRole("heading", { name: "delta", exact: true }).count(), 1, "过期详情不能替换当前方法");
    await page.locator(`#sym-${gamma.id}`).click();
    await panel.getByRole("heading", { name: "gamma", exact: true }).waitFor();
    assert.equal(gammaRequests, 2, "过期响应不应写入缓存");

    // The original cached alpha remains usable after leaving a pending request.
    await page.locator(`#sym-${alpha.id}`).click();
    await panel.getByRole("heading", { name: "alpha", exact: true }).waitFor();

    const alphaAnalysis = hold(), analysisStarted = hold();
    await page.route(`**/api/projects/${project.id}/symbols/${alpha.id}/analysis`, async (route) => { analysisStarted.release(); await alphaAnalysis.promise; await route.fulfill({ status: 503, json: { error: "过期分析错误" } }); });
    await page.getByRole("button", { name: "变量", exact: true }).click(); await analysisStarted.promise;
    await page.locator(`#sym-${beta.id}`).click();
    await panel.getByText("betaValue", { exact: true }).waitFor();
    const analysisUrl = `/api/projects/${project.id}/symbols/${alpha.id}/analysis`;
    const analysisCount = await readCount(analysisUrl);
    alphaAnalysis.release(); await settleRead(analysisUrl, analysisCount);
    assert.equal(await panel.getByText("过期分析错误").count(), 0);
    assert.equal(await panel.getByText("betaValue", { exact: true }).count(), 1, "过期分析失败不能覆盖当前方法的分析结果");

    // The browser intercepts the entire generation request; the server's upstream is also local-only.
    await page.getByRole("button", { name: "讲解", exact: true }).click();
    await page.locator(`#sym-${alpha.id}`).click();
    await panel.getByRole("heading", { name: "alpha", exact: true }).waitFor();
    const generation = hold(), generationStarted = hold();
    await page.route(`**/api/projects/${project.id}/symbols/${alpha.id}/explain`, async (route) => {
      generationStarted.release(); await generation.promise;
      await route.fulfill({ status: 200, contentType: "application/json", json: { explanation: "模拟 alpha 讲解结果", model: "fixture", generatedAt: null, backend: "api", cached: false } });
    });
    await panel.getByRole("button", { name: "生成 AI 讲解" }).click(); await generationStarted.promise;
    await page.locator(`#sym-${beta.id}`).click();
    await panel.getByRole("heading", { name: "beta", exact: true }).waitFor();
    const generationResponse = page.waitForResponse((response) => response.url().endsWith(`/symbols/${alpha.id}/explain`));
    generation.release(); await generationResponse;
    assert.equal(await panel.getByText("模拟 alpha 讲解结果").count(), 0);
    await page.locator(`#sym-${alpha.id}`).click();
    await panel.getByText("模拟 alpha 讲解结果").waitFor();
  } finally {
    releases.forEach((release) => release());
    if (browser) await browser.close();
    if (app && app.exitCode === null) {
      const closed = once(app, "close");
      if (process.platform === "win32") {
        const kill = spawn("taskkill", ["/pid", String(app.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        await once(kill, "close");
      } else app.kill();
      await closed;
    }
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith("atlas-selection-ui-"));
    await rm(temp, { recursive: true, force: true });
  }
});
