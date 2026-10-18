"use client";

import { Children, useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "code-atlas:panel-ratio:v1";
const DEFAULT_RATIO = 60;

export function ResizablePanels({ children }: { children: ReactNode }) {
  const panels = Children.toArray(children);
  const container = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const current = useRef(DEFAULT_RATIO);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    if (container.current) observer.observe(container.current);
    const frame = requestAnimationFrame(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const saved = raw === null ? NaN : Number(raw);
        if (Number.isFinite(saved) && saved >= 20 && saved <= 80) {
          current.current = saved;
          setRatio(saved);
        }
      } catch { /* Storage may be unavailable. */ }
    });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  // Each side gets 240px where space permits; narrow windows share the space.
  const minimum = width > 8 ? Math.min(45, Math.max(20, 240 / (width - 8) * 100)) : 20;
  const clamp = (value: number) => Math.max(minimum, Math.min(100 - minimum, value));
  const shownRatio = clamp(ratio);
  const update = (next: number, persist = false) => {
    const value = clamp(next);
    current.current = value;
    setRatio(value);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* Optional preference. */ }
    }
  };

  return <div ref={container} className={`relative grid min-h-0 min-w-0 flex-1 ${dragging ? "select-none cursor-col-resize" : ""}`} style={{ gridTemplateColumns: `minmax(0, ${shownRatio}fr) 8px minmax(0, ${100 - shownRatio}fr)` }}>
    {panels[0]}
    <div role="separator" tabIndex={0} aria-label="调整中间与右侧面板宽度" aria-orientation="vertical" aria-valuemin={Math.ceil(minimum)} aria-valuemax={Math.floor(100 - minimum)} aria-valuenow={Math.round(shownRatio)} aria-valuetext={`中间 ${Math.round(shownRatio)}%，右侧 ${Math.round(100 - shownRatio)}%`}
      title="拖动调整宽度；方向键微调；双击恢复默认"
      className={`z-20 flex touch-none cursor-col-resize items-center justify-center outline-none hover:bg-indigo-500/30 focus-visible:bg-indigo-500/40 ${dragging ? "bg-indigo-500/40" : "bg-slate-950"}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const rect = container.current?.getBoundingClientRect();
        if (rect && rect.width > 8) update((event.clientX - rect.left - 4) / (rect.width - 8) * 100);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        update(current.current, true);
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => { setDragging(false); update(current.current, true); }}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => update(DEFAULT_RATIO, true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 5 : 1;
        const next = event.key === "ArrowLeft" ? shownRatio - step : event.key === "ArrowRight" ? shownRatio + step : event.key === "Home" ? minimum : event.key === "End" ? 100 - minimum : event.key === "Enter" ? DEFAULT_RATIO : null;
        if (next !== null) { event.preventDefault(); update(next, true); }
      }}><span className="h-10 w-0.5 rounded bg-slate-500" /></div>
    {panels[1]}
  </div>;
}
