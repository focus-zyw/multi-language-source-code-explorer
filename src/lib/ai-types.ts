export type ExplanationBackend = "api" | "agent";
export type AgentPhase = "starting" | "running" | "responding" | "finishing";
/** 仅传递安全的重试状态，不包含上游错误原文或配置。 */
export interface ChatRetryState {
  attempt: number;
  maxAttempts: number;
  reason: "rate-limit" | "timeout" | "network" | "server";
  /** 下一次请求的预计时间；null 表示已经开始该次请求。 */
  retryAt: number | null;
}
export interface ExplanationResponse extends ExplanationResult {
  backend: ExplanationBackend;
  cached: boolean;
  durationMs?: number;
}
export type ExplanationEvent =
  | { type: "progress"; phase: AgentPhase; elapsedMs: number; timeoutMs?: number }
  | { type: "delta"; text: string }
  | { type: "retry"; retry: ChatRetryState }
  | { type: "result"; result: ExplanationResponse }
  | { type: "error"; error: string };

export interface ExplanationResult {
  explanation: string;
  model: string | null;
  generatedAt: string | null;
  relativeLines?: boolean;
}

export interface AiPublicStatus {
  configured: boolean;
  model: string | null;
  defaultBackend: ExplanationBackend;
  backends: Record<ExplanationBackend, { available: boolean; model: string | null }>;
}
