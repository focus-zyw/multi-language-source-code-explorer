export type ViewerResolution = "exact" | "inferred" | "heuristic" | "external" | "unresolved";

export interface ViewerRef {
  id: number;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  resolution: ViewerResolution;
  label: string;
}

export interface ViewerHighlight {
  startLine: number;
  endLine: number;
  startCol?: number;
  endCol?: number;
}

export interface CodeViewerProps {
  content: string;
  language: string;
  /** 变化时重置滚动位置（文件或方法切换） */
  fileKey: string;
  range: { startLine: number; endLine: number };
  mode: "method" | "file";
  refs: ViewerRef[];
  highlight: ViewerHighlight | null;
  onRefClick: (id: number) => void;
}

export function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split("\n").slice(startLine - 1, endLine).join("\n");
}
