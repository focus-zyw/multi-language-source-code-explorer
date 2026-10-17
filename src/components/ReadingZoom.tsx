"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { readingPreferences, type ReadingRegion } from "@/lib/reading-preferences";

/** Capture before Monaco handles wheel events; ordinary scrolling stays native. */
export function ReadingZoom({ region, children, className = "" }: {
  region: ReadingRegion;
  children: (fontSize: number) => ReactNode;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const preferences = useSyncExternalStore(readingPreferences.subscribe, readingPreferences.getSnapshot, readingPreferences.getServerSnapshot);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let accumulated = 0;
    let lastEvent = 0;
    let lastChange = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (now - lastEvent > 180) accumulated = 0;
      lastEvent = now;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1);
      if (Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
      accumulated += delta;
      if (Math.abs(accumulated) < 40 || now - lastChange < 60) return;
      readingPreferences.adjust(region, accumulated < 0 ? 1 : -1);
      accumulated = 0;
      lastChange = now;
    };
    const options = { capture: true, passive: false };
    element.addEventListener("wheel", wheel, options);
    return () => element.removeEventListener("wheel", wheel, options);
  }, [region]);

  return <div ref={host} className={className} data-reading-region={region}>
    {children(preferences[region])}
    {preferences.notice === region && <div className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-xs text-slate-200 shadow-lg"
      onMouseEnter={readingPreferences.pauseNotice} onMouseLeave={readingPreferences.hideNoticeLater}
      onFocus={readingPreferences.pauseNotice} onBlur={readingPreferences.hideNoticeLater}>
      <span role="status">{region === "code" ? "代码" : "讲解"}字号 {preferences[region]}px</span>
      <button onClick={() => readingPreferences.reset(region)} className="rounded px-1 py-1 text-indigo-300 hover:text-indigo-100 focus-visible:outline-2 focus-visible:outline-indigo-400">恢复默认</button>
    </div>}
  </div>;
}

export function ReadingShortcutHint() {
  const preferences = useSyncExternalStore(readingPreferences.subscribe, readingPreferences.getSnapshot, readingPreferences.getServerSnapshot);
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    // Defer the claim so Strict Mode's initial setup/cleanup cannot consume it.
    const showTimer = setTimeout(() => {
      if (readingPreferences.showHintOnce()) hideTimer = setTimeout(readingPreferences.dismissHint, 8000);
    }, 0);
    return () => { clearTimeout(showTimer); clearTimeout(hideTimer); readingPreferences.dismissHint(); };
  }, []);
  if (!preferences.hint) return null;
  return <div className="fixed bottom-6 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-xs leading-5 text-slate-200 shadow-lg">
    <span role="status">Ctrl + 鼠标滚轮：调整鼠标所在代码区或讲解区的字号</span>
    <button onClick={readingPreferences.dismissHint} className="shrink-0 rounded px-1 py-1 text-indigo-300 hover:text-indigo-100 focus-visible:outline-2 focus-visible:outline-indigo-400">知道了</button>
  </div>;
}
