// A deterministic process fixture; no model service is contacted.
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const mode = args[args.indexOf("--model") + 1];
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
else if (mode === "integration") emit("## 一句话概述\nAgent 测试讲解：该函数将输入乘以二并返回。\n");
else if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("private diagnostic should stay on the server"); process.exitCode = 1; }
else if (mode === "large") process.stdout.write("x".repeat(140_000));
else if (mode !== "empty") emit(JSON.stringify({ prompt, args, cwd: process.cwd(), leakedKey: !!process.env.AI_API_KEY }));
