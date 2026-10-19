"use client";

import { useEffect, useRef, useState } from "react";
import type { LocalFolderListing } from "@/lib/api-types";

export function LocalFolderPicker({ initial, onChoose, onClose }: { initial: LocalFolderListing; onChoose: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState(initial);
  const [address, setAddress] = useState(initial.path);
  const [selected, setSelected] = useState<{ name: string; path: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    addressRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      controller.current?.abort();
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  async function navigate(path: string) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects/local/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }), signal: current.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "无法打开文件夹");
      if (current.signal.aborted) return;
      setListing(body);
      setAddress(body.path);
      setSelected(null);
      setFilter("");
    } catch (error) {
      if (!current.signal.aborted) setError(error instanceof Error ? error.message : "无法打开文件夹");
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  const folders = listing.folders.filter((folder) => folder.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const chosen = selected?.path ?? listing.path;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="local-folder-title" aria-busy={busy}
      className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]');
        if (!elements?.length) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div><h2 id="local-folder-title" className="text-base font-semibold text-slate-100">选择本地文件夹</h2><p className="mt-1 text-xs text-slate-400">单击选择，双击打开；也可填写地址后点击前往。</p></div>
        <button type="button" onClick={onClose} aria-label="关闭文件夹选择" className="rounded-lg px-3 py-2 text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-400">×</button>
      </header>
      <div className="space-y-3 border-b border-slate-800 px-5 py-3">
        <div className="flex flex-wrap gap-2">{listing.shortcuts.map((shortcut) => <button key={shortcut.name + shortcut.path} type="button" disabled={busy} onClick={() => navigate(shortcut.path)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-400 hover:bg-slate-800 disabled:opacity-40">{shortcut.name}</button>)}</div>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void navigate(address); }}>
          <button type="button" disabled={busy || !listing.parent} onClick={() => listing.parent && navigate(listing.parent)} aria-label="返回上级文件夹" className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40">上级</button>
          <label htmlFor="folder-picker-address" className="sr-only">文件夹地址</label>
          <input ref={addressRef} id="folder-picker-address" value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-400" />
          <button type="submit" disabled={busy || !address.trim()} className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40">前往</button>
        </form>
        <label htmlFor="folder-picker-filter" className="sr-only">筛选当前文件夹</label>
        <input id="folder-picker-filter" value={filter} onChange={(event) => { setFilter(event.target.value); setSelected(null); }} placeholder="筛选当前目录的文件夹" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-400" />
      </div>
      <div className="min-h-48 overflow-y-auto px-5 py-3" aria-live="polite">
        {error && <p role="alert" className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
        {busy ? <p className="py-8 text-center text-sm text-slate-400">正在读取文件夹…</p> : <>
          {!folders.length && <p className="py-8 text-center text-sm text-slate-400">{filter ? "没有匹配的文件夹，请调整筛选条件。" : "没有子文件夹，可以直接选择当前文件夹。"}</p>}
          <ul className="space-y-1">{folders.map((folder) => <li key={folder.path}>
            <div className="flex gap-2">
              <button type="button" aria-pressed={selected?.path === folder.path} onClick={() => setSelected(folder)} onDoubleClick={() => navigate(folder.path)}
                className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-indigo-400 ${selected?.path === folder.path ? "border-indigo-500/70 bg-indigo-500/15 text-indigo-200" : "border-transparent text-slate-200 hover:bg-slate-800"}`}>
                <span className="shrink-0 text-slate-500" aria-hidden="true">▸</span><span className="truncate">{folder.name}</span>
              </button>
              <button type="button" onClick={() => navigate(folder.path)} aria-label={`打开文件夹 ${folder.name}`} className="shrink-0 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-indigo-300">打开</button>
            </div>
          </li>)}</ul>
          {listing.truncated && <p className="mt-3 text-xs text-amber-200">目录条目较多，仅显示部分文件夹；可在地址栏直接输入目标目录。</p>}
        </>}
      </div>
      <footer className="border-t border-slate-800 px-5 py-4">
        <p className="mb-3 break-all font-mono text-xs text-slate-400">将选择：{chosen}</p>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">取消</button>
          <button type="button" disabled={busy} onClick={() => onChoose(chosen)} className="atlas-primary px-4 py-2 text-sm">选择此文件夹</button>
        </div>
      </footer>
    </div>
  </div>;
}
