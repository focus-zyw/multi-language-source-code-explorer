import { createHash } from "node:crypto";
import type { SymbolMetrics } from "./analysis/types.ts";

export interface FingerprintTarget { filePath: string; name: string; kind: string; confidence: string }
export interface FingerprintCall { kind: string; calleeText: string; line: number; col?: number; resolution: string; targets: FingerprintTarget[] }
export interface ExplanationFingerprintInput {
  filePath: string;
  language: string;
  source: string;
  symbol: { qualifiedName: string; kind: string; signature: string; docstring: string | null; decorators?: string[]; metrics: SymbolMetrics; startLine: number; endLine: number; startCol: number; endCol: number };
  calls: FingerprintCall[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Bump this version when the explanation's prompt semantics or supplied facts change. */
export function fingerprintExplanation(input: ExplanationFingerprintInput, absoluteLines = false): string {
  const { symbol } = input;
  const calls = [...input.calls].sort((a, b) => a.line - b.line || (a.col ?? 0) - (b.col ?? 0)).map((call) => ({ kind: call.kind, calleeText: call.calleeText, line: call.line - symbol.startLine + 1,
    resolution: call.resolution, targets: call.targets.map((target) => ({ filePath: target.filePath.replaceAll("\\", "/"), name: target.name, kind: target.kind, confidence: target.confidence }))
      .sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))) }));
  const decoratedJs = ["javascript", "typescript", "vue"].includes(input.language) && !!symbol.decorators?.length;
  const value = { version: decoratedJs ? 3 : ["html", "json"].includes(input.language) ? 2 : 1, ...(decoratedJs ? { decorators: symbol.decorators } : {}), filePath: input.filePath.replaceAll("\\", "/"), language: input.language, source: input.source.replace(/\r\n?/g, "\n"),
    qualifiedName: symbol.qualifiedName, kind: symbol.kind, signature: symbol.signature, docstring: symbol.docstring, metrics: symbol.metrics, calls,
    ...(absoluteLines ? { position: [symbol.startLine, symbol.endLine, symbol.startCol, symbol.endCol] } : {}) };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function explanationContentKey(configKey: string, fingerprint: string): string { return `${configKey}:content-v1:${fingerprint}`; }
export function storedExplanationFingerprint(key: string): string | null { return /:content-v1:([a-f0-9]{64})$/.exec(key)?.[1] ?? null; }
export function explanationMatchesConfig(key: string, configKey: string): boolean {
  return key === configKey || key.startsWith(`${configKey}:content-v1:`) && storedExplanationFingerprint(key) !== null;
}
