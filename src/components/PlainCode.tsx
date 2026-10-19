"use client";

import { useEffect, useMemo, useRef } from "react";
import { sliceLines, type CodeViewerProps } from "./viewer-types";

/** Monaco 无法加载时的备用只读查看器：同样支持行号、引用着色/点击与高亮 */
export default function PlainCode({ content, fileKey, range, mode, refs, highlight, onRefClick, onSelection, fontSize = 14 }: CodeViewerProps) {
  const offset = mode === "method" ? range.startLine - 1 : 0;
  const lines = useMemo(() => (mode === "method" ? sliceLines(content, range.startLine, range.endLine) : content).split("\n"), [content, mode, range.startLine, range.endLine]);
  const hostRef = useRef<HTMLDivElement>(null);

  const byLine = useMemo(() => {
    const m = new Map<number, typeof refs>();
    for (const r of refs) {
      if (r.line !== r.endLine) continue;
      const l = m.get(r.line) ?? [];
      l.push(r);
      m.set(r.line, l);
    }
    for (const l of m.values()) l.sort((a, b) => a.col - b.col);
    return m;
  }, [refs]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    el.scrollTop = 0;
    if (mode === "file") {
      const target = el.querySelector(`[data-line="${range.startLine}"]`);
      target?.scrollIntoView({ block: "start" });
    }
  }, [fileKey, mode, range.startLine]);

  useEffect(() => {
    if (highlight) hostRef.current?.querySelector(`[data-line="${highlight.startLine}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div ref={hostRef} onMouseUp={(event) => { const selected = window.getSelection(); const text = selected?.toString().slice(0, 6000) ?? ""; if (!selected?.anchorNode || !selected.focusNode || !event.currentTarget.contains(selected.anchorNode) || !event.currentTarget.contains(selected.focusNode)) return; const line = (node: Node) => Number((node instanceof Element ? node : node.parentElement)?.closest("[data-line]")?.getAttribute("data-line")); const a = line(selected.anchorNode), b = line(selected.focusNode); onSelection?.(text.trim() && a && b ? { text, startLine: Math.min(a, b), endLine: Math.max(a, b) } : null); }} style={{ fontSize, lineHeight: `${Math.round(fontSize * 1.6)}px` }} className="plain-code h-full overflow-auto bg-slate-950 py-2 font-mono text-slate-200">
      {lines.map((text, i) => {
        const ln = i + 1 + offset;
        const inSym = mode === "file" && ln >= range.startLine && ln <= range.endLine;
        const hl = highlight && ln >= highlight.startLine && ln <= highlight.endLine;
        const rs = byLine.get(ln) ?? [];
        const parts: React.ReactNode[] = [];
        let last = 0;
        for (const r of rs) {
          const s = r.col - 1;
          const e = r.endCol - 1;
          if (s < last) continue;
          if (s > last) parts.push(text.slice(last, s));
          parts.push(
            <span key={r.id} className={`ref ref-${r.resolution}`} title={r.label} onClick={() => onRefClick(r.id)}>
              {text.slice(s, e)}
            </span>,
          );
          last = e;
        }
        parts.push(text.slice(last));
        return (
          <div key={i} data-line={ln} className={`flex whitespace-pre ${hl ? "flow-hl" : inSym ? "sym-bg" : ""}`}>
            <span className="inline-block w-14 shrink-0 select-none pr-3 text-right text-slate-600">{ln}</span>
            <span>{parts}</span>
          </div>
        );
      })}
    </div>
  );
}
