/** 前后端共享的纯类型与常量（不得引入 Node 专用模块） */

export interface SkipRecord {
  path: string;
  reason: string;
}

export interface SkippedInfo {
  counts: Record<string, number>;
  samples: SkipRecord[];
}

export interface ProjectStats {
  scanTimings?: { decodeMs: number; parseMs: number; resolveMs: number; testLinkMs: number; transactionOtherMs: number; totalMs: number };
  symbols: { function: number; method: number; class: number; test: number; element?: number; property?: number };
  refs: { exact: number; inferred: number; heuristic: number; external: number; unresolved: number };
  testLinks: { exact: number; inferred: number; indirect: number; heuristic: number };
  syntaxErrorFiles: number;
  unresolvedImports: number;
}

export interface FileImportInfo {
  specifier: string;
  names: string[];
  line: number;
  kind: "project" | "external" | "unresolved";
  resolvedPath: string | null;
  guess: boolean;
  reason: string | null;
}

export const SKIP_REASON_LABELS: Record<string, string> = {
  "ignored-dir": "忽略目录（node_modules / .git / 构建产物等）",
  "unsupported-language": "暂不支持的语言/文件类型",
  "declaration-file": "类型声明文件（.d.ts）",
  minified: "压缩/打包产物",
  "too-large": "文件过大",
  binary: "二进制内容",
  "non-utf8": "非 UTF-8 文本",
  symlink: "符号链接（出于安全不处理）",
  "special-file": "特殊文件（出于安全不处理）",
  encrypted: "加密条目",
  "path-traversal": "路径穿越（已拒绝）",
  "absolute-path": "绝对路径（已拒绝）",
  "invalid-path": "非法路径（已拒绝）",
  "path-too-long": "路径过长/过深",
  "suspicious-ratio": "压缩比异常（疑似 ZIP 炸弹）",
  "total-limit": "超出总体积上限",
  "file-limit": "超出文件数量上限",
  "parse-failed": "解析失败",
  "parse-timeout": "解析超时",
  "unsupported-compression": "不支持的压缩方式",
  duplicate: "重复路径",
};

export type SymbolKindT = "function" | "method" | "class" | "test";
export type ResolutionT = "exact" | "inferred" | "heuristic" | "external" | "unresolved";

export const RESOLUTION_LABELS: Record<ResolutionT, { label: string; hint: string }> = {
  exact: { label: "确定", hint: "由语法结构 / import 绑定 / 所属类可静态确定" },
  inferred: { label: "推断", hint: "基于类型标注、构造调用、继承或路径别名推断，较可信但未完全验证" },
  heuristic: { label: "候选·猜测", hint: "仅按名称等启发式匹配，未验证，可能有误" },
  external: { label: "外部/内建", hint: "来自项目之外的库、标准库或语言内建" },
  unresolved: { label: "无法解析", hint: "静态分析无法确定被调对象" },
};
