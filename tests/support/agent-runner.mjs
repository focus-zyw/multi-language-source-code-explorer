// A deterministic process fixture; no model service is contacted.
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const mode = args[args.indexOf("--model") + 1];
if (mode === "integration") process.stdout.write("## 一句话概述\nAgent 测试讲解：该函数将输入乘以二并返回。\n");
else if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("private diagnostic should stay on the server"); process.exitCode = 1; }
else if (mode === "large") process.stdout.write("x".repeat(140_000));
else if (mode !== "empty") process.stdout.write(JSON.stringify({ prompt, args, cwd: process.cwd(), leakedKey: !!process.env.AI_API_KEY }));
