import { ImportError } from "./rules.ts";

/** Local filesystem endpoints are available only through the local application. */
export function checkLocalRequest(req: Request): void {
  const url = new URL(req.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new ImportError("本地路径导入只允许在运行应用的本机访问", 403);
  const host = req.headers.get("host");
  if (host && host !== url.host) throw new ImportError("请求地址不匹配", 403);
  const origin = req.headers.get("origin");
  if ((origin && origin !== url.origin) || req.headers.get("sec-fetch-site") === "cross-site") throw new ImportError("不允许跨站访问本地源码目录", 403);
  if (!req.headers.get("content-type")?.includes("application/json")) throw new ImportError("请求需要 application/json", 415);
}

export async function readLocalBody(req: Request): Promise<Record<string, unknown>> {
  checkLocalRequest(req);
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 8192) throw new ImportError("请求内容过长", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new ImportError("请求需要 JSON 对象");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new ImportError("请求内容过长", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ImportError("请求需要有效的 JSON 对象"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ImportError("请求需要 JSON 对象");
  return body as Record<string, unknown>;
}
