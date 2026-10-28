import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentArguments, completeAgent, getAgentConfig, type AgentConfig } from "../src/lib/agent.ts";

const fixture = fileURLToPath(new URL("./support/agent-runner.mjs", import.meta.url));
function config(model = "success"): AgentConfig {
  return { command: process.execPath, prefix: [fixture], model, timeoutMs: 10_000 };
}

test("agent uses stdin, disables shell tools, filters credentials and cleans its workspace", async () => {
  const previous = process.env.AI_API_KEY;
  process.env.AI_API_KEY = "test-only-value";
  try {
    const text = "source with backticks ` and $(shell text) and quotes \"";
    const result = JSON.parse(await completeAgent(config(), "system", text));
    assert.ok(result.prompt.includes(text));
    assert.ok(!result.args.includes(text));
    assert.ok(result.args.includes("read-only"));
    assert.ok(result.args.includes("--ignore-user-config"));
    assert.ok(result.args.includes("features.shell_tool=false"));
    const lastIndex = result.args.indexOf("--output-last-message");
    assert.ok(lastIndex >= 0);
    assert.ok(result.args[lastIndex + 1].startsWith(result.cwd));
    assert.equal(result.leakedKey, false);
    assert.equal(existsSync(result.cwd), false);
  } finally {
    if (previous === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous;
  }
});

test("agent failures do not expose process diagnostics", async () => {
  await assert.rejects(completeAgent(config("fail"), "system", "source"), (error: Error) => {
    assert.match(error.message, /Codex 运行失败/);
    assert.ok(!error.message.includes("private diagnostic"));
    return true;
  });
});

test("agent rejects empty and oversized output", async () => {
  await assert.rejects(completeAgent(config("empty"), "system", "source"), /空内容/);
  await assert.rejects(completeAgent(config("large"), "system", "source"), /超过上限/);
});

test("agent timeout stops the process", async () => {
  await assert.rejects(completeAgent({ ...config("timeout"), timeoutMs: 250 }, "system", "source"), /超时/);
});

test("agent cancellation works before and during execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(completeAgent(config(), "system", "source", controller.signal), /取消/);
  const active = new AbortController();
  const result = completeAgent(config("timeout"), "system", "source", active.signal);
  setTimeout(() => active.abort(), 150);
  await assert.rejects(result, /取消/);
});

test("agent model is passed as one argument", () => {
  const args = agentArguments(config("model with spaces"));
  assert.equal(args[args.indexOf("--model") + 1], "model with spaces");
});

test("agent can be disabled without affecting API configuration", () => {
  const previous = process.env.AI_AGENT_ENABLED;
  process.env.AI_AGENT_ENABLED = "false";
  try { assert.equal(getAgentConfig(), null); }
  finally {
    if (previous === undefined) delete process.env.AI_AGENT_ENABLED;
    else process.env.AI_AGENT_ENABLED = previous;
  }
});

test("agent returns only final text from fragmented JSONL and reports safe lifecycle phases", async () => {
  const phases: string[] = [];
  const result = await completeAgent(config("events-success"), "system", "source", undefined, (phase) => phases.push(phase));
  assert.equal(result, "最终讲解");
  assert.deepEqual(phases, ["starting", "running", "responding", "finishing"]);
  assert.ok(agentArguments(config()).includes("--json"));
});

test("agent recovers the final text from the message file when item events are dropped", async () => {
  assert.equal(await completeAgent(config("file-only"), "system", "source"), "文件最终讲解");
});

test("agent prefers the message file over streamed items", async () => {
  assert.equal(await completeAgent(config("file-and-events"), "system", "source"), "文件最终讲解");
});

test("agent still rejects an empty or oversized message file", async () => {
  await assert.rejects(completeAgent(config("file-empty"), "system", "source"), /空内容/);
  await assert.rejects(completeAgent(config("file-large"), "system", "source"), /超过上限/);
});

test("agent accepts a recovered turn after a transient error event", async () => {
  assert.equal(await completeAgent(config("events-recovered"), "system", "source"), "恢复后的最终讲解");
});

test("agent rejects unrecovered error events without disclosing diagnostics or partial results", async () => {
  for (const mode of ["events-error-exit", "events-error-partial"]) {
    await assert.rejects(completeAgent(config(mode), "system", "source"), (error: Error) => {
      assert.match(error.message, /出错/);
      assert.ok(!error.message.includes("private"));
      return true;
    });
  }
});

test("a retrying agent remains cancellable and bounded by the original timeout", async () => {
  await assert.rejects(completeAgent({ ...config("events-error"), timeoutMs: 500 }, "system", "source"), /超时/);
  const controller = new AbortController();
  const pending = completeAgent(config("events-error"), "system", "source", controller.signal);
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending, /取消/);
});

test("agent rejects failed and incomplete turns without disclosing diagnostics", async () => {
  for (const mode of ["events-failed", "events-error-failed", "events-incomplete"]) {
    await assert.rejects(completeAgent(config(mode), "system", "source"), (error: Error) => {
      assert.ok(!error.message.includes("private"));
      assert.match(error.message, /失败|未完成/);
      return true;
    });
  }
});

test("agent can stop after reporting that its turn has started", async () => {
  const controller = new AbortController();
  await assert.rejects(completeAgent(config("events-wait"), "system", "source", controller.signal, (phase) => {
    if (phase === "running") controller.abort();
  }), /取消/);
});
