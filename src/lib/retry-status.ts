import type { ChatRetryState } from "./ai-types.ts";

export function retryStatus(retry: ChatRetryState, now?: number): string {
  const attempt = `第 ${retry.attempt}/${retry.maxAttempts} 次尝试`;
  if (retry.retryAt === null) return `正在重试 · ${attempt}`;
  const reason = retry.reason === "rate-limit" ? "等待限流解除" : "等待重试";
  const remaining = now === undefined ? "" : ` · 约 ${Math.max(0, Math.ceil((retry.retryAt - now) / 1000))} 秒后重试`;
  return `${reason}${remaining} · ${attempt}`;
}
