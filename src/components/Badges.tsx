"use client";

import { RESOLUTION_LABELS, type ResolutionT } from "@/lib/shared";

const STYLE: Record<ResolutionT, string> = {
  exact: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  inferred: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  heuristic: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  external: "bg-slate-500/15 text-slate-300 ring-slate-500/40",
  unresolved: "bg-rose-500/15 text-rose-300 ring-rose-500/40",
};

export function ConfidenceBadge({ level, score }: { level: ResolutionT; score?: number }) {
  const meta = RESOLUTION_LABELS[level];
  return (
    <span title={meta.hint} className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STYLE[level]}`}>
      {meta.label}
      {typeof score === "number" && level !== "exact" ? <span className="opacity-70">{Math.round(score * 100)}%</span> : null}
    </span>
  );
}

const TEST_STYLE: Record<string, { label: string; cls: string; hint: string }> = {
  exact: { label: "确定·直接调用", cls: STYLE.exact, hint: "测试代码中的调用被静态确定地解析到该方法" },
  inferred: { label: "推断·直接调用", cls: STYLE.inferred, hint: "调用目标依赖类型标注/构造推断或路径别名，较可信" },
  indirect: { label: "间接调用", cls: "bg-violet-500/15 text-violet-300 ring-violet-500/40", hint: "测试 → 某方法 → 本方法，沿确定/推断的调用边传递一层" },
  heuristic: { label: "猜测·命名/候选", cls: STYLE.heuristic, hint: "仅依据命名或同名候选匹配，未验证实际调用关系" },
};

export function TestConfidenceBadge({ level, score }: { level: string; score?: number }) {
  const m = TEST_STYLE[level] ?? TEST_STYLE.heuristic;
  return (
    <span title={m.hint} className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${m.cls}`}>
      {m.label}
      {typeof score === "number" && level !== "exact" ? <span className="opacity-70">{Math.round(score * 100)}%</span> : null}
    </span>
  );
}

const KIND_META: Record<string, { icon: string; cls: string; label: string }> = {
  function: { icon: "ƒ", cls: "text-indigo-300", label: "函数" },
  method: { icon: "m", cls: "text-fuchsia-300", label: "方法" },
  class: { icon: "C", cls: "text-amber-300", label: "类" },
  test: { icon: "✓", cls: "text-emerald-300", label: "测试" },
};

export function KindIcon({ kind }: { kind: string }) {
  const m = KIND_META[kind] ?? KIND_META.function;
  return (
    <span title={m.label} className={`inline-block w-4 shrink-0 text-center font-mono text-[12px] font-bold ${m.cls}`}>
      {m.icon}
    </span>
  );
}

export function kindLabel(kind: string) {
  return KIND_META[kind]?.label ?? kind;
}

export function Chip({ children, title, tone = "slate" }: { children: React.ReactNode; title?: string; tone?: "slate" | "indigo" | "emerald" | "amber" | "rose" }) {
  const tones = {
    slate: "bg-slate-800 text-slate-300",
    indigo: "bg-indigo-500/20 text-indigo-200",
    emerald: "bg-emerald-500/20 text-emerald-200",
    amber: "bg-amber-500/20 text-amber-200",
    rose: "bg-rose-500/20 text-rose-200",
  };
  return (
    <span title={title} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}
