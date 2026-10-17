/**
 * 导入规则：路径安全、忽略目录、体积上限。
 * 本模块是纯函数，前端（上传前预过滤）与后端（强制校验）共用；后端不信任前端的任何过滤结果。
 */

export const LIMITS = {
  maxZipBytes: 100 * 1024 * 1024, // 上传 ZIP 体积
  maxUploadBytes: 120 * 1024 * 1024, // 单次请求体积
  maxEntries: 60_000, // ZIP 条目数
  maxAnalyzedFiles: 5_000, // 参与分析的文件数
  maxFileBytes: 1024 * 1024, // 单个源码文件
  maxTotalReadBytes: 150 * 1024 * 1024, // 实际解压/读取总字节
  maxPathLength: 400,
  maxPathDepth: 40,
  maxCompressionRatio: 200, // 单文件压缩比阈值（仅对 >64KB 的文件判定）
  maxSymbols: 80_000,
} as const;

export const SUPPORTED_EXTENSIONS = [".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".go", ".java", ".vue", ".html", ".htm", ".json"];

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages",
  "bower_components",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  ".gradle",
  "vendor",
  "__MACOSX",
]);

export type PathCheck = { ok: true; path: string } | { ok: false; reason: "path-traversal" | "absolute-path" | "invalid-path" | "path-too-long" };

/** 规范化并校验归档/上传条目路径：拒绝绝对路径、`..` 穿越、NUL/控制字符、过长路径 */
export function normalizeEntryPath(raw: string): PathCheck {
  if (!raw || raw.includes("\0") || /[\x00-\x1f]/.test(raw)) return { ok: false, reason: "invalid-path" };
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return { ok: false, reason: "absolute-path" };
  const segments = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "path-traversal" };
  if (!segments.length) return { ok: false, reason: "invalid-path" };
  if (segments.length > LIMITS.maxPathDepth || p.length > LIMITS.maxPathLength) return { ok: false, reason: "path-too-long" };
  return { ok: true, path: segments.join("/") };
}

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/** 仅根据路径判断是否应跳过（不读取内容）。返回 null 表示应读取 */
export function classifyPath(path: string): string | null {
  const segs = path.split("/");
  for (let i = 0; i < segs.length - 1; i++) {
    if (IGNORED_DIRS.has(segs[i]) || IGNORED_DIRS.has(segs[i].toLowerCase())) return "ignored-dir";
  }
  const lower = path.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(lower)) return "declaration-file";
  if (/\.(min|bundle)\.[cm]?js$/.test(lower) || /[.-]chunk\.[a-z0-9]+\.js$/.test(lower)) return "minified";
  if (!SUPPORTED_EXTENSIONS.includes(extOf(path))) return "unsupported-language";
  return null;
}

/** 若所有路径共享唯一顶层目录（典型的“项目文件夹/ZIP 根目录”），返回该目录名 */
export function commonRoot(paths: string[]): string | null {
  if (!paths.length) return null;
  const first = paths[0].split("/");
  if (first.length < 2) return null;
  const root = first[0];
  return paths.every((p) => p.startsWith(root + "/")) ? root : null;
}

export class ImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
