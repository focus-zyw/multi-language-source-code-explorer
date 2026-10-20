export interface LearningAnchor {
  version: 1; path: string; language: string; kind: string; name: string;
  hash: string; unique: boolean;
}
export interface AnchorResolution {
  status: "resolved" | "missing" | "ambiguous";
  freshness: "unchanged" | "changed" | "unknown";
  symbolId: number | null; line: number | null;
}
export interface BookmarkView extends AnchorResolution { id: string; anchor: LearningAnchor }
export interface LearningSnapshot {
  revision: number; bookmarks: BookmarkView[];
  selected: LearningAnchor | null; root: LearningAnchor | null;
}
export interface ReadingPosition {
  version: 1; projectCreatedAt: string; revision: number;
  selected: LearningAnchor; root: LearningAnchor | null;
  view: "source" | "explore"; direction: "incoming" | "outgoing";
  tab: string; mode: "method" | "file";
}
export function isLearningAnchor(value: unknown): value is LearningAnchor {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return a.version === 1 && typeof a.unique === "boolean" &&
    ["path", "language", "kind", "name"].every((key) => typeof a[key] === "string" && (a[key] as string).length <= 2048) &&
    typeof a.hash === "string" && /^[a-f0-9]{64}$/.test(a.hash);
}
export function readReadingPosition(text: string | null, projectCreatedAt: string): ReadingPosition | null {
  try {
    if (!text || text.length > 12000) return null;
    const value = JSON.parse(text);
    if (value.version !== 1 || value.projectCreatedAt !== projectCreatedAt || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !isLearningAnchor(value.selected) || value.root !== null && !isLearningAnchor(value.root) ||
      !["source", "explore"].includes(value.view) || !["incoming", "outgoing"].includes(value.direction) ||
      !["explain", "questions", "refs", "tests", "flow", "vars", "notes"].includes(value.tab) || !["method", "file"].includes(value.mode)) return null;
    return value as ReadingPosition;
  } catch { return null; }
}
