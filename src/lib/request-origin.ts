/** 讲解等 JSON 接口的请求来源校验。 */
export function isSameOriginRequest(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const incoming = new URL(req.url);
    const host = req.headers.get("host");
    // 使用实际入站 Host；Next.js 可能把 req.url 改写成 localhost 或内部端口。
    if (host && /[/\\@?#\s]/.test(host)) return false;
    const expected = host ? new URL(`${incoming.protocol}//${host}`) : incoming;
    const source = new URL(origin);
    if (!["http:", "https:"].includes(source.protocol) || source.origin !== origin) return false;
    if (source.origin === expected.origin) return true;
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return source.protocol === expected.protocol && source.port === expected.port &&
      loopback.has(source.hostname) && loopback.has(expected.hostname);
  } catch { return false; }
}
