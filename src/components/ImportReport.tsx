"use client";

import type { ProjectInfo } from "@/lib/api-types";
import { RESOLUTION_LABELS, SKIP_REASON_LABELS } from "@/lib/shared";

const LANG: Record<string, string> = { python: "Python", javascript: "JavaScript", typescript: "TypeScript" };

export function ImportReport({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const st = project.stats;
  const skippedEntries = Object.entries(project.skipped.counts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">导入报告 · {project.name}</h2>
            <p className="mt-1 text-xs text-slate-400">
              {project.fileCount} 个源码文件 · {project.symbolCount} 个符号 · {(project.totalBytes / 1024).toFixed(0)} KB ·{" "}
              {Object.entries(project.languages)
                .map(([l, n]) => `${LANG[l] ?? l} ${n}`)
                .join(" / ")}
            </p>
          </div>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800">
            ✕
          </button>
        </div>

        {project.sourcePath && <div className="mt-4 rounded-lg bg-slate-950/60 p-3 text-xs leading-5 text-slate-400">
          <p className="break-all">本地来源：<span className="font-mono text-slate-200">{project.sourcePath}</span></p>
          {project.scannedAt && <p>最近扫描：{new Date(project.scannedAt).toLocaleString("zh-CN")}</p>}
          <p>重新扫描会更新该项目的全部分析，并清除旧讲解缓存；不会修改源码。</p>
        </div>}
        {project.warnings.length > 0 && (
          <div className="mt-4 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
            {project.warnings.map((w, i) => (
              <p key={i}>⚠ {w}</p>
            ))}
          </div>
        )}

        {st && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-950/60 p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">符号</h3>
              <ul className="space-y-1 text-sm text-slate-300">
                <li>函数 {st.symbols.function}</li>
                <li>方法 {st.symbols.method}</li>
                <li>类 {st.symbols.class}</li>
                <li>测试用例 {st.symbols.test}</li>
              </ul>
              {st.syntaxErrorFiles > 0 && <p className="mt-2 text-xs text-amber-300">{st.syntaxErrorFiles} 个文件含语法错误，解析可能不完整（文件树中标 ⚠）</p>}
            </div>
            <div className="rounded-xl bg-slate-950/60 p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">调用解析结果</h3>
              <ul className="space-y-1 text-sm text-slate-300">
                {(Object.keys(RESOLUTION_LABELS) as (keyof typeof st.refs)[]).map((k) => (
                  <li key={k} title={RESOLUTION_LABELS[k].hint}>
                    {RESOLUTION_LABELS[k].label} <b>{st.refs[k]}</b>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">无法解析的导入：{st.unresolvedImports} 项</p>
            </div>
            <div className="rounded-xl bg-slate-950/60 p-4 sm:col-span-2">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">测试关联</h3>
              <p className="text-sm text-slate-300">
                确定 {st.testLinks.exact} · 推断 {st.testLinks.inferred} · 间接 {st.testLinks.indirect} · 猜测 {st.testLinks.heuristic}
              </p>
            </div>
          </div>
        )}

        <div className="mt-5 rounded-xl bg-slate-950/60 p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-200">被跳过的内容</h3>
          {skippedEntries.length === 0 && <p className="text-xs text-slate-500">无</p>}
          <ul className="space-y-1 text-sm text-slate-300">
            {skippedEntries.map(([k, v]) => (
              <li key={k} className="flex justify-between gap-4">
                <span>{k.startsWith("client:") ? `（浏览器预过滤）${SKIP_REASON_LABELS[k.slice(7)] ?? k.slice(7)}` : (SKIP_REASON_LABELS[k] ?? k)}</span>
                <span className="text-slate-500">{v}</span>
              </li>
            ))}
          </ul>
          {project.skipped.samples.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-indigo-300">查看示例路径（{project.skipped.samples.length}）</summary>
              <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px] text-slate-400">
                {project.skipped.samples.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="shrink-0 text-slate-600">{SKIP_REASON_LABELS[s.reason]?.split("（")[0] ?? s.reason}</span>
                    <span className="min-w-0 break-all">{s.path}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
