export type ExplanationBackend = "api" | "agent";

export interface ExplanationResult {
  explanation: string;
  model: string | null;
  generatedAt: string | null;
}

export interface AiPublicStatus {
  configured: boolean;
  model: string | null;
  defaultBackend: ExplanationBackend;
  backends: Record<ExplanationBackend, { available: boolean; model: string | null }>;
}
