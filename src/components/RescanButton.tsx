"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function RescanButton({ projectId, sourcePath, inWorkspace = false }: { projectId: number; sourcePath: string; inWorkspace?: boolean }) {
  const router = useRouter();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  async function rescan() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/rescan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `重新扫描失败（HTTP ${response.status}）`);
      if (inWorkspace) {
        // Drop symbol/analysis caches and old symbol deep links together.
        window.location.assign(`/p/${projectId}`);
      } else {
        setResult(`扫描完成：${body.fileCount} 个文件，${body.symbolCount} 个符号，保留 ${body.preservedExplanations ?? 0} 份讲解`);
        router.refresh();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "重新扫描失败，已保留原有分析");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <div className="relative shrink-0">
    <button type="button" onClick={rescan} disabled={busy} aria-busy={busy} title={`重新读取 ${sourcePath}，保留内容指纹未变化的讲解`}
      className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-indigo-400 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:cursor-wait disabled:opacity-50">
      {busy ? "正在扫描…" : "重新扫描"}
    </button>
    <div aria-live="polite" className={inWorkspace ? "absolute right-0 top-full z-40 mt-2 w-72" : "mt-1 max-w-64"}>
      {busy && <p className="rounded bg-slate-900 px-2 py-1 text-xs text-indigo-200">正在读取源码，完成后更新项目。</p>}
      {error && <p role="alert" className="rounded bg-slate-900 px-2 py-1 text-xs text-rose-300">{error}</p>}
      {result && <p className="text-xs text-emerald-300">{result}</p>}
    </div>
  </div>;
}
