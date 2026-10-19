"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "code-atlas:sidebar-width:v1";
const DEFAULT_WIDTH = 260;

export function ResizableSidebar({ children }: { children: ReactNode }) {
  const sidebar = useRef<HTMLElement>(null);
  const [preferred, setPreferred] = useState(DEFAULT_WIDTH);
  const [available, setAvailable] = useState(0);
  const [dragging, setDragging] = useState(false);
  const current = useRef(DEFAULT_WIDTH);

  useEffect(() => {
    const parent = sidebar.current?.parentElement;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    if (parent) observer.observe(parent);
    const frame = requestAnimationFrame(() => {
      try {
        const saved = Number(localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(saved) && saved >= 160 && saved <= 480) {
          current.current = saved;
          setPreferred(saved);
        }
      } catch { /* Width remains adjustable without browser storage. */ }
    });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  const minimum = available ? Math.min(180, available * .4) : 180;
  const maximum = available ? Math.max(minimum, Math.min(480, available - 480)) : 480;
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  const width = clamp(preferred);
  const update = (next: number, persist = false) => {
    current.current = next;
    setPreferred(next);
    if (persist) {
      // Keep the user's preferred desktop width when a narrow window clamps it.
      try { localStorage.setItem(STORAGE_KEY, String(Math.max(160, Math.min(480, next)))); } catch { /* Optional preference. */ }
    }
  };

  return <>
    <aside ref={sidebar} aria-label="项目文件与符号" className="atlas-sidebar min-w-0 shrink-0" style={{ width }}>{children}</aside>
    <div role="separator" tabIndex={0} aria-label="调整文件树宽度" aria-orientation="vertical" aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} 像素`}
      title="拖动调整文件树宽度；方向键微调；双击或 Enter 恢复默认"
      className={`atlas-sidebar-resizer z-20 flex w-2 shrink-0 touch-none cursor-col-resize items-center justify-center outline-none ${dragging ? "bg-indigo-500/30" : "bg-slate-950"}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const rect = sidebar.current?.getBoundingClientRect();
        if (rect) update(clamp(event.clientX - rect.left - 4));
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        update(current.current, true); event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false);
      }}
      onPointerCancel={() => { setDragging(false); update(current.current, true); }}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => update(DEFAULT_WIDTH, true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const next = event.key === "ArrowLeft" ? clamp(width - step) : event.key === "ArrowRight" ? clamp(width + step) : event.key === "Home" ? minimum : event.key === "End" ? maximum : event.key === "Enter" ? DEFAULT_WIDTH : null;
        if (next !== null) { event.preventDefault(); update(next, true); }
      }}><span className="h-10 w-0.5 rounded bg-slate-500" /></div>
  </>;
}
