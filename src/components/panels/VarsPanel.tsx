"use client";

import { useState } from "react";
import type { AnalysisResult } from "@/lib/api-types";
import type { VariableInfo } from "@/lib/analysis/types";
import type { ViewerHighlight } from "../viewer-types";
import { Chip } from "../Badges";

interface Props {
  state: { loading: boolean; error: string | null; data: AnalysisResult | null };
  onHighlight: (h: ViewerHighlight | null) => void;
}

const KIND: Record<VariableInfo["kind"], { label: string; tone: "indigo" | "emerald" | "amber" | "rose" | "slate" }> = {
  param: { label: "参数", tone: "indigo" },
  local: { label: "局部变量", tone: "slate" },
  loop: { label: "循环变量", tone: "amber" },
  catch: { label: "异常变量", tone: "rose" },
  with: { label: "上下文变量", tone: "slate" },
  field: { label: "对象字段", tone: "emerald" },
};

const TAG: Record<string, string> = { returned: "参与返回值", condition: "用于条件判断", raised: "用于抛出异常" };

export function VarsPanel({ state, onHighlight }: Props) {
  const [onlyKey, setOnlyKey] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (state.loading) return <div className="p-8 text-center text-sm text-slate-500">正在分析变量…</div>;
  if (state.error) return <div className="p-4 text-sm text-rose-300">{state.error}</div>;
  if (!state.data) return null;
  const vars = state.data.variables;
  const list = onlyKey ? vars.filter((v) => v.importance >= 4) : vars;

  const toggle = (name: string) =>
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs leading-5 text-slate-400">共 {vars.length} 个变量，按重要度排序（参数、参与返回值/条件判断、出现次数越多越靠前）。</p>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-slate-300">
          <input type="checkbox" checked={onlyKey} onChange={(e) => setOnlyKey(e.target.checked)} />
          仅关键
        </label>
      </div>
      {list.length === 0 && <p className="py-8 text-center text-sm text-slate-500">{vars.length ? "没有达到“关键”阈值的变量" : "该方法没有可识别的变量"}</p>}
      <ul className="space-y-2">
        {list.map((v) => {
          const isOpen = open.has(v.name);
          const key = v.importance >= 4;
          return (
            <li key={v.name} className="rounded-lg border border-slate-800 bg-slate-900/60">
              <button
                onClick={() => {
                  toggle(v.name);
                  if (v.definition) onHighlight({ startLine: v.definition.line, endLine: v.definition.line, startCol: v.definition.col, endCol: v.definition.endCol });
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-100">{v.name}</span>
                {key && <Chip tone="amber">关键</Chip>}
                <Chip tone={KIND[v.kind].tone}>{KIND[v.kind].label}</Chip>
                <span className="text-[11px] text-slate-500">
                  读{v.readCount}/写{v.writeCount}
                </span>
              </button>
              <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
                {v.typeText && <Chip title="类型标注">{v.typeText}</Chip>}
                {v.declKeyword && <Chip title="声明关键字">{v.declKeyword}</Chip>}
                {v.tags.map((t) => (
                  <Chip key={t} tone="indigo">
                    {TAG[t] ?? t}
                  </Chip>
                ))}
              </div>
              {isOpen && (
                <div className="space-y-2 border-t border-slate-800 px-3 py-2 text-xs">
                  <div>
                    <div className="mb-0.5 text-slate-500">定义</div>
                    {v.definition ? (
                      <button
                        onClick={() => onHighlight({ startLine: v.definition!.line, endLine: v.definition!.line, startCol: v.definition!.col, endCol: v.definition!.endCol })}
                        className="block w-full rounded bg-slate-950 px-2 py-1.5 text-left font-mono text-[12px] text-slate-300 hover:bg-slate-800"
                      >
                        <span className="mr-2 text-slate-500">L{v.definition.line}</span>
                        {v.definition.snippet}
                        {v.definition.where === "class" && <span className="ml-2 text-emerald-300/80">（类中其他位置）</span>}
                      </button>
                    ) : (
                      <p className="text-amber-300/80">{v.definitionNote ?? "未找到定义"}</p>
                    )}
                  </div>
                  <div>
                    <div className="mb-0.5 text-slate-500">在本方法中的引用（{v.occurrences.length}）</div>
                    <div className="flex flex-wrap gap-1">
                      {v.occurrences.map((o, i) => (
                        <button
                          key={i}
                          onClick={() => onHighlight({ startLine: o.line, endLine: o.line, startCol: o.col, endCol: o.endCol })}
                          className={`rounded px-1.5 py-0.5 font-mono text-[11px] hover:brightness-125 ${o.access === "write" ? "bg-rose-500/20 text-rose-200" : o.access === "def" ? "bg-indigo-500/25 text-indigo-100" : "bg-slate-800 text-slate-300"}`}
                          title={o.access === "write" ? "写入" : o.access === "def" ? "定义" : "读取"}
                        >
                          L{o.line} {o.access === "write" ? "写" : o.access === "def" ? "定义" : "读"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {state.data.notes.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-lg bg-slate-900/50 p-3 text-[11px] leading-5 text-slate-500">
          {state.data.notes.map((n, i) => (
            <li key={i}>※ {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
