import type Parser from "web-tree-sitter";

export type SyntaxNode = Parser.SyntaxNode;

export type LanguageId = "python" | "javascript" | "typescript" | "go";
export type SymbolKind = "function" | "method" | "class" | "test";

/** 关系可信度：exact=语法/导入绑定可确定；inferred=基于类型标注/构造推断；heuristic=仅按名称等启发式猜测 */
export type Confidence = "exact" | "inferred" | "heuristic";
/** 调用解析结果；external=外部依赖/内建；unresolved=无法解析 */
export type Resolution = Confidence | "external" | "unresolved";

export interface ParamInfo {
  name: string;
  display: string;
  type: string | null;
  defaultValue: string | null;
}

export interface SymbolMetrics {
  loc: number;
  params: number;
  branches: number;
  loops: number;
  handlers: number;
  returns: number;
  throws: number;
  awaits: number;
  booleanOps: number;
  complexity: number;
}

export interface ExtractedSymbol {
  localId: number;
  parentLocalId: number | null;
  /** 最近的外层类（方法及其内部嵌套函数共享） */
  classLocalId: number | null;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  /** 所属类名 / 对象字面量名 / describe 路径 */
  container: string | null;
  isAsync: boolean;
  isGenerator: boolean;
  isTest: boolean;
  isDefaultExport: boolean;
  signature: string;
  params: ParamInfo[];
  decorators: string[];
  docstring: string | null;
  returnType: string | null;
  bases: string[];
  /** 展示范围（含装饰器 / export），行列均为 1 基 */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  startIndex: number;
  endIndex: number;
  /** 定义节点（带函数体的节点）范围，用于重新定位 AST 节点 */
  defStartIndex: number;
  defEndIndex: number;
  metrics: SymbolMetrics;
}

export type ReceiverKind = "self" | "super" | "name" | "expr";

export interface ExtractedCall {
  ownerLocalId: number;
  kind: "call" | "new" | "jsx";
  /** 被调名（最后一段标识符）；动态调用为 null */
  name: string | null;
  receiver: string | null;
  receiverKind: ReceiverKind | null;
  calleeText: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface TypeHint {
  ownerLocalId: number | null;
  classLocalId: number | null;
  variable: string;
  typeName: string;
  source: "annotation" | "constructor";
  /** true 表示 self.x / this.x 字段 */
  field: boolean;
}

export interface ImportBinding {
  /** 本地绑定名；'*' 表示通配导入 */
  local: string;
  /** 代码中引用该绑定的完整路径（Python `import a.b` 为 a.b） */
  localPath: string;
  specifier: string;
  /** 目标模块内的名称；'*'=整个模块；'default'=默认导出；'*wildcard'=通配 */
  imported: string;
  reexport: boolean;
  line: number;
}

export interface ExtractResult {
  /** Package namespace for languages whose declarations span sibling files. */
  moduleName?: string | null;
  symbols: ExtractedSymbol[];
  calls: ExtractedCall[];
  imports: ImportBinding[];
  hints: TypeHint[];
  defaultExportName: string | null;
  hasSyntaxErrors: boolean;
}

/* ---------------- 流程图 ---------------- */

export interface IRBase {
  startLine: number;
  endLine: number;
}

export type IRStmt =
  | (IRBase & { t: "stmt"; label: string; calls: string[] })
  | (IRBase & { t: "if"; cond: string; calls: string[]; then: IRStmt[]; else: IRStmt[] })
  | (IRBase & { t: "loop"; kind: "for" | "while" | "do"; cond: string; calls: string[]; body: IRStmt[]; orElse: IRStmt[] })
  | (IRBase & {
      t: "try";
      body: IRStmt[];
      handlers: { label: string; startLine: number; endLine: number; body: IRStmt[] }[];
      orElse: IRStmt[];
      finally: IRStmt[];
    })
  | (IRBase & {
      t: "switch";
      disc: string;
      calls: string[];
      fallthrough: boolean;
      cases: { label: string; startLine: number; endLine: number; body: IRStmt[]; isDefault: boolean }[];
    })
  | (IRBase & { t: "return"; label: string; calls: string[] })
  | (IRBase & { t: "throw"; label: string; calls: string[] })
  | (IRBase & { t: "break" })
  | (IRBase & { t: "continue" });

export type FlowNodeKind =
  | "start"
  | "end"
  | "process"
  | "decision"
  | "loop"
  | "return"
  | "throw"
  | "try"
  | "handler"
  | "switch"
  | "case";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  startLine: number;
  endLine: number;
  calls: string[];
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind: "normal" | "back" | "exception";
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  truncated: boolean;
}

/* ---------------- 变量 ---------------- */

export type VariableKind = "param" | "local" | "loop" | "catch" | "with" | "field";

export interface VarOccurrence {
  line: number;
  col: number;
  endCol: number;
  access: "def" | "read" | "write";
}

export interface VariableInfo {
  name: string;
  kind: VariableKind;
  typeText: string | null;
  declKeyword: string | null;
  definition: { line: number; col: number; endCol: number; snippet: string; where: "method" | "class" } | null;
  definitionNote: string | null;
  occurrences: VarOccurrence[];
  readCount: number;
  writeCount: number;
  tags: string[];
  importance: number;
}

/* ---------------- 语言插件 ---------------- */

export interface FileIndex {
  has(path: string): boolean;
  bySuffix(suffix: string): string[];
}

export type ImportResolution =
  | { kind: "project"; path: string; guess: boolean }
  | { kind: "external" }
  | { kind: "unresolved"; reason: string };

export interface LanguagePlugin {
  id: LanguageId;
  label: string;
  extensions: string[];
  /** 返回 tree-sitter grammar 名称（对应 tree-sitter-wasms 文件） */
  grammarFor(ext: string): string;
  isTestFile(path: string): boolean;
  extract(root: SyntaxNode, source: string, filePath: string): ExtractResult;
  flowIR(def: SyntaxNode, source: string): IRStmt[];
  analyzeVariables(def: SyntaxNode, source: string): VariableInfo[];
  resolveImport(fromPath: string, specifier: string, index: FileIndex): ImportResolution;
  /** `from pkg import mod` 时拼出可能的子模块说明符 */
  joinSubmodule(specifier: string, name: string): string | null;
  builtinFunctions: Set<string>;
  globalObjects: Set<string>;
  builtinMethods: Set<string>;
  constructorNames: string[];
}
