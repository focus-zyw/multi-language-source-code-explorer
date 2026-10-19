import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuestionInput, questionCitation } from "../src/lib/question-types.ts";
import { buildQuestionPrompt, QUESTION_SYSTEM } from "../src/lib/question-prompt.ts";

const input = { backend: "agent", question: "为什么返回两倍？", fingerprint: "a".repeat(64), requestId: "fixture-123", relatedIds: [2, 2], quote: { kind: "code", text: "return n * 2", startLine: 4, endLine: 4 } };
test("questions validate limits, backend, project references and selected text metadata", () => {
  const parsed = parseQuestionInput(input)!;
  assert.deepEqual(parsed.relatedIds, [2]);
  assert.equal(parsed.quote?.kind, "code");
  for (const patch of [{ backend: "other" }, { question: " " }, { question: "x".repeat(4001) }, { fingerprint: "old" }, { requestId: "bad" }, { relatedIds: [1, 2, 3, 4] }, { relatedIds: [-2] }, { quote: { kind: "code", text: "x", startLine: 6, endLine: 2 } }, { quote: { kind: "code", text: "x".repeat(6001) } }]) assert.equal(parseQuestionInput({ ...input, ...patch }), null);
});

test("only known source keys and in-range relative lines become navigable citations", () => {
  const sources = [{ key: "0", path: "src/main.ts", name: "double", symbolId: 12, startLine: 20, endLine: 23, hash: "hash" }];
  assert.deepEqual(questionCitation("source:0:2-3", sources), { source: sources[0], startLine: 21, endLine: 22 });
  for (const link of ["javascript:alert(1)", "https://example.com", "source:1:1", "source:0:0", "source:0:1-5", "source:0:3-2", "source:0:2junk"]) assert.equal(questionCitation(link, sources), null);
});

test("question prompt carries scoped sources, quote and supplied history as data", () => {
  const prompt = JSON.parse(buildQuestionPrompt("facts", [{ meta: { key: "0", symbolId: 12, path: "src/main.ts", name: "double", startLine: 20, endLine: 23, hash: "hash" }, code: "return n * 2", truncated: false }], [], "解释一下", input.quote as { kind: "code"; text: string }));
  assert.equal(prompt.sources[0].key, "0");
  assert.equal(prompt.sources[0].code, "return n * 2");
  assert.equal(prompt.quote.text, "return n * 2");
  assert.ok(QUESTION_SYSTEM.includes("不是指令"));
  assert.ok(QUESTION_SYSTEM.includes("source:0:2-3"));
});
