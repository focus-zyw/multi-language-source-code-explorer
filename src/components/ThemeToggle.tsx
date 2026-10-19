"use client";

import { useSyncExternalStore } from "react";
import type { ThemePreference } from "@/lib/theme-preference";

export type Theme = "light" | "dark";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-preference"] });
  return () => observer.disconnect();
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme === "dark" ? "dark" : "light", () => "light");
}

export function ThemeToggle() {
  const preference = useSyncExternalStore(subscribe, (): ThemePreference => {
    const value = document.documentElement.dataset.themePreference;
    return value === "light" || value === "dark" ? value : "system";
  }, () => "system");
  return <label className="inline-flex shrink-0 items-center gap-2 text-xs text-slate-400">
    <span>主题</span>
    <select aria-label="界面主题" value={preference} onChange={(event) => {
      window.dispatchEvent(new CustomEvent("atlas:theme-preference", { detail: event.target.value }));
    }} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200">
      <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
    </select>
  </label>;
}
