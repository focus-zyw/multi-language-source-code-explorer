import { ImportError } from "./rules.ts";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** Parses a `Host` header without letting `new URL` absorb a path, query or credentials. */
function parseHostHeader(value: string): { hostname: string; port: string } | null {
  if (!value || /[/\\@?#\s]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return null;
  }
}

/**
 * Loopback aliases (`localhost`, `127.0.0.1`, `[::1]`) are the same machine, so they may be
 * mixed freely as long as the port still matches the address the app is actually listening on.
 */
function matchesLoopbackPort(hostname: string, port: string, url: URL): boolean {
  if (!LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) return false;
  return (port || defaultPort(url.protocol)) === (url.port || defaultPort(url.protocol));
}

function isLoopbackOrigin(origin: string, url: URL): boolean {
  if (origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== url.protocol) return false;
  return matchesLoopbackPort(parsed.hostname, parsed.port, url);
}

/** Local filesystem endpoints are available only through the local application. */
export function checkLocalRequest(req: Request): void {
  const url = new URL(req.url);
  if (!LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) throw new ImportError("本地路径导入只允许在运行应用的本机访问", 403);
  const host = req.headers.get("host");
  if (host) {
    const parsed = parseHostHeader(host);
    if (!parsed || !matchesLoopbackPort(parsed.hostname, parsed.port, url)) throw new ImportError("请求地址不匹配，请通过本机地址和当前端口访问", 403);
  }
  const origin = req.headers.get("origin");
  if ((origin && !isLoopbackOrigin(origin, url)) || req.headers.get("sec-fetch-site") === "cross-site") throw new ImportError("不允许跨站访问本地源码目录", 403);
  if (!req.headers.get("content-type")?.includes("application/json")) throw new ImportError("请求需要 application/json", 415);
}

export async function readLocalBody(req: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  checkLocalRequest(req);
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new ImportError("请求内容过长", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new ImportError("请求需要 JSON 对象");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ImportError("请求内容过长", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ImportError("请求需要有效的 JSON 对象"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ImportError("请求需要 JSON 对象");
  return body as Record<string, unknown>;
}
