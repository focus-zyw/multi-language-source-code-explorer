"use client";

import { useSyncExternalStore } from "react";

const KEY = "code-atlas:theme:v1";
export type Theme = "light" | "dark";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      document.documentElement.dataset.theme = event.newValue === "dark" ? "dark" : "light";
    }
  };
  window.addEventListener("storage", onStorage);
  return () => { observer.disconnect(); window.removeEventListener("storage", onStorage); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme === "dark" ? "dark" : "light", () => "light");
}

export function ThemeToggle() {
  const theme = useTheme();
  return <label className="inline-flex shrink-0 items-center gap-2 text-xs text-slate-400">
    <span>主题</span>
    <select aria-label="界面主题" value={theme} onChange={(event) => {
      const next = event.target.value === "dark" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch { /* Theme still works when storage is unavailable. */ }
    }} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200">
      <option value="light">浅色</option><option value="dark">深色</option>
    </select>
  </label>;
}
