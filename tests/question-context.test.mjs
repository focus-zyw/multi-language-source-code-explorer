import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuestionContext } from "../src/lib/question-context.ts";

function fixture() {
  return {
    symbol: { qualifiedName: "Counter.increment", kind: "method", signature: "increment(step)", startLine: 2, startCol: 3, endLine: 4, endCol: 4, docstring: "增加计数" },
    file: { path: "src/counter.ts", language: "typescript", content: 'unrelated\n  increment(step) {\n    return "你好😀";\n  }; trailing\nother()', hasSyntaxErrors: false },
    summary: { headline: "方法 Counter.increment", bullets: ["参数 1 个：step"] },
    outgoing: [{ line: 3, calleeText: "helper", resolution: "heuristic", reason: "仅按名称匹配", targets: [{ name: "helper", filePath: "src/helper.ts", line: 8, confidence: "heuristic" }] }],
    ai: { explanations: { agent: { explanation: "不能自动选取其他来源的讲解" } } },
  };
}

test("question context copies exactly the selected range and preserves confidence and relative path", () => {
  const text = buildQuestionContext(fixture(), "api");
  assert.ok(text.includes('increment(step) {\n    return "你好😀";\n  }'));
  assert.ok(!text.includes("unrelated"));
  assert.ok(!text.includes("trailing"));
  assert.ok(!text.includes("other()"));
  assert.ok(text.includes("src/counter.ts"));
  assert.ok(text.includes("L2:3–L4:4"));
  assert.ok(text.includes("helper [猜测]"));
  assert.ok(text.includes("src/helper.ts:8 helper [猜测]"));
  assert.ok(text.includes("当前来源尚无已完成"));
  assert.ok(!text.includes("不能自动选取其他来源"));
});

test("completed explanation identifies selected source, model, date and generation boundary", () => {
  const text = buildQuestionContext(fixture(), "agent", { explanation: "已有讲解", model: "fixture-model", generatedAt: "2026-10-18T00:00:00Z", relativeLines: true }, true);
  for (const value of ["本机 Agent · Codex", "fixture-model", "2026-10-18T00:00:00Z", "已有讲解", "不包含生成中的结果", "片段第 1 行", "辅助解释，需对照源码核验"]) assert.ok(text.includes(value), value);
});

test("single-line columns, markdown fences, syntax warnings and omitted calls remain explicit", () => {
  const detail = fixture();
  detail.file.content = 'before`snippet```after';
  detail.file.hasSyntaxErrors = true;
  Object.assign(detail.symbol, { startLine: 1, endLine: 1, startCol: 7, endCol: 18 });
  const text = buildQuestionContext(detail, "api", { explanation: "```md\nquoted\n```", model: null, generatedAt: null });
  assert.ok(text.includes('````typescript\n`snippet```\n````'));
  assert.ok(text.includes("含语法错误"));
  detail.outgoing = Array(201).fill(detail.outgoing[0]);
  assert.ok(buildQuestionContext(detail, "api").includes("前 200/201 项；源码未截断"));
});
