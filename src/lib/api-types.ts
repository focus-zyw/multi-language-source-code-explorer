import type { FileImportInfo, ProjectStats, SkippedInfo, ResolutionT } from "./shared";
import type { FlowGraph, ParamInfo, SymbolMetrics, VariableInfo } from "./analysis/types";
import type { StaticSummary } from "./analysis/summary";
import type { AiPublicStatus, ExplanationBackend, ExplanationResult } from "./ai-types";

export interface ProjectListItem {
  id: number;
  name: string;
  sourceType: string;
  sourcePath: string | null;
  scannedAt: string | null;
  fileCount: number;
  symbolCount: number;
  languages: Record<string, number>;
  stats: ProjectStats | null;
  createdAt: string;
}

export interface ProjectInfo extends ProjectListItem {
  totalBytes: number;
  skipped: SkippedInfo;
  warnings: string[];
}

export interface LocalFolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  shortcuts: { name: string; path: string }[];
  truncated: boolean;
}

export interface TreeFile {
  id: number;
  path: string;
  language: string;
  isTest: boolean;
  hasSyntaxErrors: boolean;
}

export interface TreeSymbol {
  id: number;
  fileId: number;
  parentId: number | null;
  kind: "function" | "method" | "class" | "test" | "element";
  name: string;
  qualifiedName: string;
  container: string | null;
  startLine: number;
  isTest: boolean;
}

export interface TreeData {
  files: TreeFile[];
  symbols: TreeSymbol[];
}

export interface RefTargetView {
  symbolId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  confidence: "exact" | "inferred" | "heuristic";
  score: number;
  reason: string;
}

export interface OutgoingRef {
  id: number;
  kind: string;
  name: string | null;
  receiver: string | null;
  calleeText: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  resolution: "exact" | "inferred" | "heuristic" | "external" | "unresolved";
  reason: string;
  targets: RefTargetView[];
}

export interface IncomingRef {
  refId: number;
  fromSymbolId: number;
  fromName: string;
  fromKind: string;
  filePath: string;
  line: number;
  calleeText: string;
  confidence: "exact" | "inferred" | "heuristic";
  score: number;
  reason: string;
}

export interface TestLinkView {
  direction: "covered-by" | "covers";
  otherSymbolId: number;
  otherName: string;
  otherKind: string;
  filePath: string;
  line: number;
  /** 该链接实际指向的被测符号（类视图下用于标明是哪个方法） */
  targetSymbolId: number;
  targetName: string;
  method: "direct-call" | "indirect-call" | "name-match";
  confidence: "exact" | "inferred" | "indirect" | "heuristic";
  score: number;
  reason: string;
  via: { id: number; name: string } | null;
}

export interface SymbolDetail {
  symbol: {
    id: number;
    fileId: number;
    parentId: number | null;
    kind: "function" | "method" | "class" | "test" | "element";
    name: string;
    qualifiedName: string;
    container: string | null;
    signature: string;
    params: ParamInfo[];
    decorators: string[];
    docstring: string | null;
    returnType: string | null;
    bases: string[];
    isAsync: boolean;
    isGenerator: boolean;
    isTest: boolean;
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    metrics: SymbolMetrics;
  };
  file: {
    id: number;
    path: string;
    language: string;
    content: string;
    isTest: boolean;
    hasSyntaxErrors: boolean;
    imports: FileImportInfo[];
  };
  parent: { id: number; name: string; kind: string } | null;
  children: { id: number; name: string; kind: string; startLine: number }[];
  summary: StaticSummary;
  ai: AiPublicStatus & {
    explanations: Partial<Record<ExplanationBackend, ExplanationResult>>;
  };
  outgoing: OutgoingRef[];
  incoming: IncomingRef[];
  tests: TestLinkView[];
}

export interface AnalysisResult {
  flow: FlowGraph | null;
  variables: VariableInfo[];
  notes: string[];
}

export type CallTreeDirection = "outgoing" | "incoming";
export interface CallTreeSymbol {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}
export interface CallTreeBranch {
  refId: number;
  label: string;
  line: number;
  filePath: string;
  resolution: ResolutionT;
  reason: string;
  targets: { symbol: CallTreeSymbol; confidence: ResolutionT; reason: string }[];
}
export interface CallTreePage {
  symbol: CallTreeSymbol;
  direction: CallTreeDirection;
  scope?: "all" | "project";
  branches: CallTreeBranch[];
  nextOffset: number | null;
}

export interface ProjectEntry {
  symbol: CallTreeSymbol;
  label: string;
  reason: string;
  confidence: "inferred" | "heuristic";
}
export interface ProjectEntryGroup {
  id: "pages" | "api" | "startup" | "candidates";
  label: string;
  description: string;
  entries: ProjectEntry[];
}
export interface ProjectEntries {
  groups: ProjectEntryGroup[];
  entryCount: number;
}
