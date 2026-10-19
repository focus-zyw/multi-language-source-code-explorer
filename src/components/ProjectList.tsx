"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectListItem } from "@/lib/api-types";
import { RescanButton } from "./RescanButton";

import { LANGUAGE_LABELS as LANG_LABEL } from "@/lib/languages";

export function ProjectList({ projects }: { projects: ProjectListItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);

  const remove = async (id: number, name: string) => {
    if (!confirm(`确定删除项目「${name}」及其分析数据？`)) return;
    setBusyId(id);
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    setBusyId(null);
    router.refresh();
  };

  if (!projects.length) {
    return (
      <div className="atlas-empty text-sm text-slate-400">
        <span className="atlas-mark" aria-hidden="true">&lt;/&gt;</span>
        <p className="text-base text-slate-200">你的源码探索，从这里开始</p>
        <p className="max-w-xs leading-6">通过左侧本地路径、文件夹或 ZIP 导入项目，建立自己的源码地图。</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {projects.map((p) => (
        <li key={p.id} className="atlas-surface atlas-project group">
          <div className="flex items-start justify-between gap-3">
            <Link href={`/p/${p.id}`} className="min-w-0 flex-1">
              <h3 className="truncate text-base font-semibold text-slate-100 group-hover:text-indigo-300">{p.name}</h3>
              <p className="mt-1 text-xs text-slate-400">
                {p.fileCount} 个文件 · {p.symbolCount} 个符号 · {p.sourceType === "local" ? "本地路径" : p.sourceType === "zip" ? "ZIP" : "文件夹"} · {new Date(p.scannedAt ?? p.createdAt).toLocaleString("zh-CN")}
              </p>
              {p.sourcePath && <p className="mt-1 truncate font-mono text-xs text-slate-500" title={p.sourcePath}>{p.sourcePath}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(p.languages).map(([l, n]) => (
                  <span key={l} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">
                    {LANG_LABEL[l] ?? l} {n}
                  </span>
                ))}
                {p.stats && (
                  <>
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">确定引用 {p.stats.refs.exact}</span>
                    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">推断 {p.stats.refs.inferred}</span>
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-300">无法解析 {p.stats.refs.unresolved}</span>
                  </>
                )}
              </div>
            </Link>
            <div className="flex shrink-0 flex-col items-end gap-2">
            {p.sourceType === "local" && p.sourcePath && <RescanButton projectId={p.id} sourcePath={p.sourcePath} />}
            <button
              onClick={() => remove(p.id, p.name)}
              disabled={busyId === p.id}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40"
            >
              删除
            </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
