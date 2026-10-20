import type { ProjectEntries, ProjectEntry, ProjectEntryGroup } from "../api-types.ts";
import { routeHint } from "./route-hints.ts";

export interface EntrySymbol {
  id: number;
  fileId: number;
  parentId: number | null;
  kind: string;
  name: string;
  qualifiedName: string;
  startLine: number;
  isTest: boolean;
  signature: string;
  decorators: string[];
}
export interface EntryFile { id: number; path: string; isTest: boolean }

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const GROUPS: Omit<ProjectEntryGroup, "entries">[] = [
  { id: "pages", label: "页面入口", description: "页面、布局及应用组件的默认导出" },
  { id: "api", label: "API 入口", description: "HTTP 处理方法与路由装饰器" },
  { id: "startup", label: "启动入口", description: "中间件及按启动文件、方法命名识别的入口候选" },
  { id: "candidates", label: "其他入口候选", description: "未识别到框架入口时，从没有项目内调用方的顶层函数开始" },
];

/** These are navigation suggestions, never synthetic call edges. No source is executed. */
export function identifyProjectEntries(files: EntryFile[], symbols: EntrySymbol[], calledIds: ReadonlySet<number>): ProjectEntries {
  const byFile = new Map(files.map((file) => [file.id, file]));
  const bySymbol = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const groups = GROUPS.map((group) => ({ ...group, entries: [] as ProjectEntry[] }));
  const candidates: ProjectEntry[] = [];
  for (const item of symbols) {
    const file = byFile.get(item.fileId);
    if (!file || item.isTest || file.isTest || /(^|\/)(?:tests?|__tests__|fixtures|__fixtures__)(\/|$)/i.test(file.path.replaceAll("\\", "/"))) continue;
    const javaMethod = /\.java$/.test(file.path) && item.kind === "method" && item.name !== "constructor";
    const parent = item.parentId === null ? undefined : bySymbol.get(item.parentId);
    const route = routeHint(item.decorators, file.path.replaceAll("\\", "/"), parent?.kind === "class" ? parent.decorators : []);
    if ((item.parentId !== null || item.kind !== "function") && !javaMethod && !(item.kind === "method" && route)) continue;
    const path = file.path.replaceAll("\\", "/");
    const base = path.split("/").at(-1)!;
    const isDefault = /^export\s+default\b/.test(item.signature);
    const exported = /^export\s/.test(item.signature);
    let group: ProjectEntryGroup["id"] | undefined;
    let label = item.qualifiedName;
    let reason = "";
    let confidence: ProjectEntry["confidence"] = "inferred";

    if (/\.vue$/.test(path) && /^Vue component /.test(item.signature)) {
      group = "pages"; reason = "Vue 单文件组件入口；包含脚本初始化与模板静态绑定，不表示具体挂载顺序";
    } else if (javaMethod && item.name === "main" && /\bstatic\s+void\s+main\s*\(/.test(item.signature)) {
      group = "startup"; reason = "按 Java static void main 方法签名识别，未验证构建配置"; confidence = "heuristic";
    } else if (route) {
      group = "api";
      reason = `${route.methods.join(" / ")} · ${route.paths.length ? route.paths.map((value) => value || "/").join("、") : "路径表达式无法静态确定"}${route.partial ? "（信息不完整，路径可能只是片段）" : ""}；${route.note}；依据：${route.evidence.join("；")}`;
    } else if (/(?:^|\/)app\/(?:.*\/)?route\.[cm]?[jt]sx?$/.test(path) && METHODS.has(item.name) && exported) {
      group = "api"; label = `${item.name} · ${path}`; reason = "App Router 的 route 文件中导出的 HTTP 处理方法";
    } else if (/(?:^|\/)pages\/api\/.+\.[cm]?[jt]sx?$/.test(path) && isDefault) {
      group = "api"; reason = "Pages Router 的 API 文件默认导出";
    } else if (/(?:^|\/)app\/(?:.*\/)?(?:page|layout)\.[cm]?[jt]sx?$/.test(path) && isDefault) {
      group = "pages"; reason = "App Router 的 page / layout 文件默认导出";
    } else if (/(?:^|\/)pages\/(?!api\/).+\.[cm]?[jt]sx?$/.test(path) && isDefault) {
      group = "pages"; reason = "Pages Router 页面文件默认导出";
    } else if (/^(?:App|_app)\.[jt]sx$/.test(base) && isDefault) {
      group = "pages"; reason = "按应用组件文件名与默认导出识别"; confidence = "heuristic";
    } else if (/^(?:middleware|proxy)\.[jt]s$/.test(base) && exported && (isDefault || item.name === base.split(".")[0])) {
      group = "startup"; reason = "按中间件文件名与导出声明识别";
    } else if (/\.go$/.test(base) && item.name === "main" && /^func\s+main\s*\(\s*\)/.test(item.signature)) {
      group = "startup"; reason = "按 Go main 函数签名识别入口候选，未验证 package 或构建配置"; confidence = "heuristic";
    } else if (/^(?:__main__|main|cli|server|index|app)\.(?:py|[cm]?[jt]sx?)$/.test(base) && /^(?:main|bootstrap|start|run|createApp)$/.test(item.name)) {
      group = "startup"; reason = "按启动文件与方法命名约定推测，尚未验证实际启动方式"; confidence = "heuristic";
    }
    const entry: ProjectEntry = { symbol: { id: item.id, name: item.qualifiedName, kind: item.kind, filePath: path, line: item.startLine }, label, reason, confidence };
    if (group) groups.find((value) => value.id === group)!.entries.push(entry);
    else if (!calledIds.has(item.id)) candidates.push({ ...entry, reason: "未找到项目内静态调用方；可能由外部调用，也可能是未使用的方法", confidence: "heuristic" });
  }
  // Do not bury recognized entry points under every unused helper in a framework app.
  if (!groups.some((group) => group.entries.length)) groups.find((group) => group.id === "candidates")!.entries = candidates;
  for (const group of groups) group.entries.sort((a, b) => a.symbol.filePath.localeCompare(b.symbol.filePath) || a.symbol.line - b.symbol.line || a.symbol.id - b.symbol.id);
  return { groups: groups.filter((group) => group.entries.length), entryCount: groups.reduce((total, group) => total + group.entries.length, 0) };
}
