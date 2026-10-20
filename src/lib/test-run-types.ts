export type RunnerKind = "node" | "vitest" | "jest" | "pytest";
export interface TestRunnerProfile {
  id: string;
  label: string;
  command: string;
  coverage: boolean;
  kind: RunnerKind;
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
  /** 测试运行期间对目标符号的调用记录；未开启追踪时为 undefined。 */
  trace?: TestRunTrace;
  traceNote?: string;
}

export interface TraceArg {
  name: string;
  value: string;
}

export interface TraceCall {
  id: number;
  func: string;
  args: TraceArg[];
  ret: string | null;
  line: number;
  depth: number;
  children: TraceCall[];
}

/** 一次测试运行里目标符号的真实调用记录。注意：多数方法是平铺的多次调用，而不是深树。 */
export interface TestRunTrace {
  target: { file: string; func: string; startLine: number; endLine: number; sourceHash: string };
  calls: number;
  nodeCount: number;
  truncated: boolean;
  roots: TraceCall[];
  note: string;
}
export interface TestRunState {
  enabled: boolean;
  reason: string;
  profiles: TestRunnerProfile[];
  run: TestRunResult | null;
}
