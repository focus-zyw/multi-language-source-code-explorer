import { MAX_CODE_CHARS, TraceError, runPythonTrace } from "@/lib/trace/python-tracer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 追踪会真实执行代码，只接受同源请求；界面在发起前还有一次显式确认。 */
export async function POST(req: Request) {
  // 比较 host 而不是完整 origin：Next 的 req.url 可能用 localhost 重写，而浏览器发的是 127.0.0.1。
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin) {
    let originHost = "";
    try { originHost = new URL(origin).host; } catch { originHost = ""; }
    if (!host || originHost !== host) return Response.json({ error: "不允许跨站执行代码" }, { status: 403 });
  }
  if (!req.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "请求需要 application/json" }, { status: 415 });

  const parsed: unknown = await req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ error: "请求需要 JSON 对象" }, { status: 400 });

  const body = parsed as { code?: unknown; entry?: unknown; args?: unknown };
  if (typeof body.code !== "string" || !body.code.trim()) return Response.json({ error: "缺少代码" }, { status: 400 });
  if (body.code.length > MAX_CODE_CHARS) return Response.json({ error: `代码不能超过 ${MAX_CODE_CHARS} 个字符` }, { status: 413 });
  if (typeof body.entry !== "string" || !body.entry.trim()) return Response.json({ error: "缺少入口函数名" }, { status: 400 });
  if (body.args !== undefined && !Array.isArray(body.args)) return Response.json({ error: "参数必须是 JSON 数组" }, { status: 400 });

  try {
    return Response.json(await runPythonTrace({ code: body.code, entry: body.entry, args: Array.isArray(body.args) ? body.args : [] }));
  } catch (error) {
    if (error instanceof TraceError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "追踪失败，请查看服务端日志" }, { status: 500 });
  }
}
