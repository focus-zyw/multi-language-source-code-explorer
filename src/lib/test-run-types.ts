export type RunnerKind = "node" | "vitest" | "jest" | "pytest";
export interface TestRunnerProfile {
  id: string;
  label: string;
  command: string;
  coverage: boolean;
}
export interface CoverageFile {
  path: string;
  lines: { line: number; hits: number }[];
  sourceHash: string;
}
export interface TestRunResult {
  id: string;
  status: "running" | "passed" | "failed" | "cancelled" | "timed-out" | "error";
  command: string;
  startedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  coverage: CoverageFile[];
  coverageNote: string;
}
export interface TestRunState {
  enabled: boolean;
  reason: string;
  profiles: TestRunnerProfile[];
  run: TestRunResult | null;
}
