"use client";

import { useEffect, useState } from "react";
import type { SymbolDetail } from "@/lib/api-types";
import type { ExplanationBackend, ExplanationResult } from "@/lib/ai-types";
import { buildQuestionContext } from "@/lib/question-context";

export function CopyQuestionContext({ detail, backend, explanation, generating, compact = false, extraText = "", related }: { detail: SymbolDetail; backend: ExplanationBackend; explanation?: ExplanationResult | null; generating: boolean; compact?: boolean; extraText?: string; related?: { projectId: number; ids: number[] } }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [manual, setManual] = useState("");
  const [failure, setFailure] = useState("");
  useEffect(() => { if (status !== "copied") return; const timer = setTimeout(() => setStatus("idle"), 2500); return () => clearTimeout(timer); }, [status]);

  const copy = async () => {
    let text = buildQuestionContext(detail, backend, explanation, generating) + extraText;
    setStatus("copying");
    if (related?.ids.length) {
      try {
        const supplemental = await Promise.all(related.ids.slice(0, 3).map(async (id) => {
          const response = await fetch(`/api/projects/${related.projectId}/symbols/${id}`);
          if (!response.ok) throw new Error("补充方法已失效");
          const value = await response.json() as SymbolDetail;
          return buildQuestionContext(value, backend);
        }));
        text += "\n\n## 本次选中的补充方法\n" + supplemental.join("\n\n");
      } catch {
        setFailure("未能读取补充方法。可重试，或先手动复制下方的当前方法上下文（不含补充方法）。");
        setManual(text); setStatus("failed"); return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setManual("");
      setStatus("copied");
    } catch {
      setFailure("浏览器未允许复制。请选中下方文本，按 Ctrl+C（Mac 按 ⌘C）复制。");
      setManual(text);
      setStatus("failed");
    }
  };

  return <div className={compact ? "relative shrink-0" : "mt-2"}>
    <button type="button" aria-label="复制提问上下文" onClick={() => void copy()} disabled={status === "copying"} className={compact ? "h-8 w-8 rounded text-lg text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400" : "rounded border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:border-indigo-400 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50"} title={status === "copied" ? "已复制" : "复制提问上下文"}>
      {compact ? status === "copied" ? "✓" : "⧉" : status === "copying" ? "正在复制…" : "复制提问上下文"}
    </button>
    <span role="status" className={compact ? "sr-only" : "ml-2 text-xs text-emerald-300"}>{status === "copied" ? "已复制" : ""}</span>
    {status === "failed" && <div className={compact ? "absolute right-0 top-full z-50 mt-1 w-72 max-w-[80vw] space-y-2 rounded border border-slate-600 bg-slate-900 p-3" : "mt-2 space-y-2"}>
      <p role="alert" className="text-xs leading-5 text-amber-200">{failure}</p>
      <textarea aria-label="手动复制提问上下文" readOnly value={manual} onFocus={(event) => event.currentTarget.select()} className="h-40 w-full rounded border border-slate-600 bg-slate-950 p-2 font-mono text-xs text-slate-200" />
      <button onClick={() => { setManual(""); setStatus("idle"); }} className="text-xs text-slate-400 hover:text-white">收起</button>
    </div>}
  </div>;
}
