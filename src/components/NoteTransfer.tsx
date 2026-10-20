"use client";
import { useState } from "react";
import { NOTE_PACKAGE_BYTES, parseNotePackage, type NotePackage, type ImportPreview } from "@/lib/note-transfer-types";
export function NoteTransfer({ projectId, selected, clearSelection, onImported }: {
  projectId: number; selected: { id: string; title: string } | null; clearSelection: () => void; onImported: () => void;
}) {
  const [includeSource, setIncludeSource] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [pending, setPending] = useState<{ pack: NotePackage; preview: ImportPreview } | null>(null);
  const url = `/api/projects/${projectId}/notes/transfer`;
  async function act(task: () => Promise<void>) {
    if (busy) return; setBusy(true); setMessage("");
    try { await task(); } catch (e) { setMessage(e instanceof Error ? e.message : "笔记流转失败"); } finally { setBusy(false); }
  }
  async function post(body: object): Promise<ImportPreview> {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "导入失败"); return data;
  }
  async function download(format: "json" | "markdown") {
    const q = new URLSearchParams({ format, source: includeSource ? "1" : "0" }); if (selected) q.set("noteId", selected.id);
    const r = await fetch(`${url}?${q}`); if (!r.ok) { const data = await r.json(); throw new Error(data.error ?? "导出失败"); }
    const objectUrl = URL.createObjectURL(await r.blob()), a = document.createElement("a");
    a.href = objectUrl; a.download = `code-atlas-notes-${projectId}${selected ? `-${selected.id}` : ""}.${format === "json" ? "json" : "md"}`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setMessage("已生成下载文件；JSON 可重新导入，Markdown 用于阅读");
  }
  return <details open={selected ? true : undefined} className="space-y-2 rounded border border-slate-700 p-3 text-xs">
    <summary>备份与导入</summary>
    <fieldset disabled={busy} className="mt-3 space-y-3">
      <p>导出范围：{selected ? selected.title : "全部正常笔记（不含回收站）"}。仅包含范围内笔记之间的关联。</p>
      {selected && <button className="underline" onClick={clearSelection}>改为导出全部笔记</button>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={includeSource} onChange={(e) => setIncludeSource(e.target.checked)} />包含源码路径、节点依据和原始选区</label>
      <p className="text-slate-400">默认只导出笔记文字、状态、标签和关联；正文中自行粘贴的代码仍会导出。未保存草稿不在导出范围。</p>
      <div className="flex gap-3"><button className="underline" onClick={() => act(() => download("json"))}>导出 JSON</button><button className="underline" onClick={() => act(() => download("markdown"))}>导出 Markdown</button></div>
      <label className="block">选择笔记 JSON（最多 10MB）<input type="file" accept=".json,application/json" className="mt-1 block max-w-full" onChange={(e) => {
        const file = e.target.files?.[0]; setPending(null); if (!file) return;
        void act(async () => {
          if (file.size > NOTE_PACKAGE_BYTES) throw new Error("文件最多 10MB");
          let value: unknown; try { value = JSON.parse(await file.text()); } catch { throw new Error("文件不是有效 JSON"); }
          const pack = parseNotePackage(value), preview = await post({ action: "preview", package: pack }); setPending({ pack, preview });
        }); e.target.value = "";
      }} /></label>
      {pending && <div className="space-y-2 rounded border border-slate-700 p-2">
        <p>导入预览：新增 {pending.preview.added} 篇（其中同 ID 冲突副本 {pending.preview.copies} 篇），跳过 {pending.preview.skipped} 篇；新增关联 {pending.preview.linksAdded} 条，跳过 {pending.preview.linksSkipped} 条。</p>
        <p>已有笔记及关联说明保持原样，补齐缺少的包内关联，跳过回收站端点。{pending.preview.evidence} 篇含源码依据，导入后仅保存历史引用，不绑定当前项目；所有新笔记使用新的本机 ID。</p>
        <button className="atlas-primary px-3 py-2" onClick={() => act(async () => {
          // Invalidate the preview on any error: a retry must use a fresh destination snapshot.
          const current = pending; setPending(null);
          const result = await post({ action: "import", package: current.pack, token: current.preview.token });
          setMessage(`导入完成：新增 ${result.added} 篇，跳过 ${result.skipped} 篇，新增关联 ${result.linksAdded} 条`); onImported();
        })}>确认导入</button>
        <button className="ml-3 underline" onClick={() => setPending(null)}>取消导入</button>
      </div>}
    </fieldset>
    {busy && <p role="status">正在处理笔记文件…</p>}{message && <p role="status" className="mt-2 break-words">{message}</p>}
  </details>;
}
