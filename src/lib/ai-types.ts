export type ExplanationBackend = "api" | "agent";
export type AgentPhase = "starting" | "running" | "responding" | "finishing";
export interface ExplanationResponse extends ExplanationResult {
  backend: ExplanationBackend;
  cached: boolean;
  durationMs?: number;
}
export type ExplanationEvent =
  | { type: "progress"; phase: AgentPhase; elapsedMs: number; timeoutMs: number }
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
