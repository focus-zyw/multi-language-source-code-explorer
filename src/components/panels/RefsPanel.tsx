"use client";

import { useEffect, useMemo, useState } from "react";
import type { OutgoingRef, SymbolDetail } from "@/lib/api-types";
import { RESOLUTION_LABELS, type ResolutionT } from "@/lib/shared";
import type { ViewerHighlight } from "../viewer-types";
import { ConfidenceBadge, KindIcon } from "../Badges";

interface Props {
  detail: SymbolDetail;
  focusRefId: number | null;
  onNavigate: (id: number, note?: { text: string; level: ResolutionT }) => void;
  onHighlight: (h: ViewerHighlight | null) => void;
}

const ORDER: ResolutionT[] = ["exact", "inferred", "heuristic", "external", "unresolved"];

export function RefsPanel({ detail, focusRefId, onNavigate, onHighlight }: Props) {
  const [dir, setDir] = useState<"out" | "in">("out");
  const [filter, setFilter] = useState<ResolutionT | "all">("all");
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (focusRefId !== null) {
      setDir("out");
      setFilter("all");
      setOpen((p) => new Set(p).add(focusRefId));
      const t = setTimeout(() => document.getElementById(`ref-${focusRefId}`)?.scrollIntoView({ block: "center" }), 80);
      return () => clearTimeout(t);
    }
  }, [focusRefId]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: detail.outgoing.length };
    for (const o of detail.outgoing) c[o.resolution] = (c[o.resolution] ?? 0) + 1;
    return c;
  }, [detail.outgoing]);

  const outgoing = detail.outgoing.filter((o) => filter === "all" || o.resolution === filter);

  const toggle = (o: OutgoingRef) => {
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(o.id)) n.delete(o.id);
      else n.add(o.id);
      return n;
    });
    onHighlight({ startLine: o.line, endLine: o.endLine, startCol: o.col, endCol: o.endCol });
  };

  const incomingGroups = useMemo(() => {
    const m = new Map<number, { name: string; kind: string; filePath: string; items: SymbolDetail["incoming"] }>();
    for (const i of detail.incoming) {
      const g = m.get(i.fromSymbolId) ?? { name: i.fromName, kind: i.fromKind, filePath: i.filePath, items: [] };
      g.items.push(i);
      m.set(i.fromSymbolId, g);
    }
    return [...m.entries()];
  }, [detail.incoming]);

  return (
    <div className="p-4">
      <div className="mb-3 flex gap-1 rounded-lg bg-slate-900 p-1">
        <button onClick={() => setDir("out")} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${dir === "out" ? "bg-indigo-500/30 text-indigo-100" : "text-slate-400"}`}>
          调用了谁（{detail.outgoing.length}）
        </button>
        <button onClick={() => setDir("in")} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${dir === "in" ? "bg-indigo-500/30 text-indigo-100" : "text-slate-400"}`}>
          被谁引用（{detail.incoming.length}）
        </button>
      </div>

      {dir === "out" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(["all", ...ORDER] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                disabled={k !== "all" && !counts[k]}
                className={`rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset disabled:opacity-30 ${filter === k ? "bg-slate-200 text-slate-900 ring-slate-200" : "text-slate-300 ring-slate-700 hover:bg-slate-800"}`}
              >
                {k === "all" ? "全部" : RESOLUTION_LABELS[k].label} {counts[k] ?? 0}
              </button>
            ))}
          </div>
          {outgoing.length === 0 && <p className="py-8 text-center text-sm text-slate-500">{detail.outgoing.length ? "该筛选下没有调用" : "方法体内没有函数调用"}</p>}
          <ul className="space-y-1.5">
            {outgoing.map((o) => {
              const isOpen = open.has(o.id);
              const single = (o.resolution === "exact" || o.resolution === "inferred") && o.targets.length === 1 ? o.targets[0] : null;
              return (
                <li key={o.id} id={`ref-${o.id}`} className={`rounded-lg border bg-slate-900/60 ${focusRefId === o.id ? "border-indigo-400" : "border-slate-800"}`}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button onClick={() => toggle(o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <span className="w-9 shrink-0 text-[11px] text-slate-500">L{o.line}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-200" title={o.calleeText}>
                        {o.kind === "new" ? "new " : o.kind === "jsx" ? "<" : ""}
                        {o.calleeText}
                        {o.kind === "jsx" ? " />" : ""}
                      </span>
                      <ConfidenceBadge level={o.resolution} />
                    </button>
                    {single && (
                      <button
                        onClick={() => onNavigate(single.symbolId, { text: `${o.calleeText} → ${single.name}：${o.reason}`, level: o.resolution })}
                        className="atlas-primary shrink-0 px-2 py-1 text-[11px]"
                      >
                        跳转
                      </button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="border-t border-slate-800 px-3 py-2 text-xs">
                      <p className="leading-5 text-slate-400">{o.reason}</p>
                      {o.targets.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {o.targets.map((t) => (
                            <li key={t.symbolId}>
                              <button
                                onClick={() => onNavigate(t.symbolId, { text: `${o.calleeText} → ${t.name}：${t.reason}`, level: t.confidence })}
                                className="flex w-full items-start gap-2 rounded bg-slate-950/60 px-2 py-1.5 text-left hover:bg-slate-800"
                              >
                                <KindIcon kind={t.kind} />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[12px] text-slate-200">{t.name}</span>
                                  <span className="block truncate text-[11px] text-slate-500">
                                    {t.filePath}:{t.line}
                                  </span>
                                </span>
                                <ConfidenceBadge level={t.confidence} score={t.score} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {o.resolution === "heuristic" && <p className="mt-2 text-[11px] text-amber-300/80">⚠ 以上候选仅按名称等启发式猜测，请对照源码确认，不要当作确定关系。</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          {incomingGroups.length === 0 && (
            <p className="py-8 text-center text-sm leading-6 text-slate-500">
              没有静态可见的引用。
              <br />
              <span className="text-xs">（入口函数、被框架/反射/动态方式调用的代码，以及未能解析的调用，都不会出现在这里）</span>
            </p>
          )}
          <ul className="space-y-2">
            {incomingGroups.map(([id, g]) => (
              <li key={id} className="rounded-lg border border-slate-800 bg-slate-900/60">
                <button
                  onClick={() => onNavigate(id, { text: `来自调用方 ${g.name}`, level: g.items[0].confidence })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/60"
                >
                  <KindIcon kind={g.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-slate-100">{g.name}</span>
                    <span className="block truncate text-[11px] text-slate-500">{g.filePath}</span>
                  </span>
                  <span className="text-[11px] text-slate-500">{g.items.length} 处</span>
                </button>
                <ul className="border-t border-slate-800 px-3 py-1.5">
                  {g.items.map((i) => (
                    <li key={i.refId} className="flex items-center gap-2 py-1 text-xs" title={i.reason}>
                      <span className="w-9 shrink-0 text-slate-500">L{i.line}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{i.calleeText}</span>
                      <ConfidenceBadge level={i.confidence} score={i.score} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {detail.incoming.length >= 300 && <p className="mt-2 text-center text-xs text-slate-500">仅显示前 300 条</p>}
        </>
      )}
    </div>
  );
}
