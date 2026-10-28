// A deterministic process fixture; no model service is contacted.
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const mode = args[args.indexOf("--model") + 1];
const lastIndex = args.indexOf("--output-last-message");
const lastPath = lastIndex >= 0 ? args[lastIndex + 1] : null;
const writeLast = (text) => { if (lastPath) writeFileSync(lastPath, text); };
const lifecycle = () => process.stdout.write(
  JSON.stringify({ type: "thread.started", thread_id: "fixture-only" }) + "\n"
  + JSON.stringify({ type: "turn.started" }) + "\n"
  + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }) + "\n");
function emit(text, completed = true) {
  if (!args.includes("--json")) { process.stdout.write(text); return; }
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fixture-only" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private diagnostic should stay on the server" } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", phase: "commentary", text: "private commentary" } }) + "\n");
  const message = JSON.stringify({ type: "item.completed", item: { type: "agent_message", phase: "final_answer", text } }) + "\n";
  // Deliberately split a JSON line across stdout chunks.
  process.stdout.write(message.slice(0, 18));
  process.stdout.write(message.slice(18));
  if (completed) process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
}
if (mode === "events-success") emit("最终讲解");
else if (mode === "events-wait") { process.stdout.write('{"type":"thread.started","thread_id":"fixture-only"}\n{"type":"turn.started"}\n'); setInterval(() => {}, 1000); }
else if (mode === "events-incomplete") emit("不完整讲解", false);
else if (mode === "events-failed") process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "private diagnostic should stay on the server" } }) + "\n");
else if (mode === "events-error") { process.stdout.write('{"type":"thread.started","thread_id":"fixture-only"}\n{"type":"turn.started"}\n{"type":"error","message":"private diagnostic should stay on the server"}\n'); setInterval(() => {}, 1000); }
else if (mode === "events-recovered") {
  process.stdout.write('{"type":"thread.started","thread_id":"fixture-only"}\n{"type":"turn.started"}\n{"type":"error","message":"private retry diagnostic"}\n');
  setTimeout(() => { writeLast("恢复后的最终讲解"); emit("恢复后的最终讲解"); }, 100);
}
else if (mode === "events-error-exit") { process.stdout.write('{"type":"error","message":"private diagnostic"}\n'); }
else if (mode === "events-error-partial") {
  process.stdout.write('{"type":"error","message":"private diagnostic"}\n');
  emit("不完整讲解", false);
  writeLast("不完整文件讲解");
}
else if (mode === "events-error-failed") {
  process.stdout.write('{"type":"error","message":"private retry diagnostic"}\n');
  process.stdout.write('{"type":"turn.failed","error":{"message":"private terminal diagnostic"}}\n');
}
else if (mode === "file-only") { lifecycle(); writeLast("文件最终讲解"); }
else if (mode === "file-and-events") { emit("流式讲解"); writeLast("文件最终讲解"); }
else if (mode === "file-empty") { lifecycle(); writeLast(""); }
else if (mode === "file-large") { lifecycle(); writeLast("x".repeat(140_000)); }
else if (mode === "integration") {
  // 模拟 CLI 内部重连后正常完成，应用不可在这个中间事件上杀掉进程。
  process.stdout.write('{"type":"error","message":"private retry diagnostic"}\n');
  emit("## 一句话概述\nAgent 测试讲解：该函数将输入乘以二并返回。\n");
}
else if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("private diagnostic should stay on the server"); process.exitCode = 1; }
else if (mode === "large") process.stdout.write("x".repeat(140_000));
else if (mode !== "empty") emit(JSON.stringify({ prompt, args, cwd: process.cwd(), leakedKey: !!process.env.AI_API_KEY }));
