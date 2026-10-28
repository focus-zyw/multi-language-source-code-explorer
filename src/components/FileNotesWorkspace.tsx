"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { TreeFile } from "@/lib/api-types";
import { fileNoteClipboard } from "@/lib/file-note-clipboard";
import { NOTE_IMAGE_MAX_BYTES, notePasteWarning } from "@/lib/file-note-rich";
import { CodeViewer } from "./CodeViewer";
import { ResizablePanels } from "./ResizablePanels";

const FileNoteMarkdown = dynamic(() => import("./FileNoteMarkdown"), { loading: () => <p className="text-sm text-slate-500">正在加载预览…</p> });
type Note = { body: string; version: number };
type FileData = { file: { content: string; language: string; lineCount: number }; note: Note; revision: number };

export function FileNotesWorkspace({ projectId, createdAt, file, revision }: { projectId: number; createdAt: string; file: TreeFile; revision: number }) {
  const url = `/api/projects/${projectId}/files/${file.id}`;
  const draftKey = `code-atlas:file-note:${projectId}:${createdAt}:${file.path}`;
  const [data, setData] = useState<FileData | null>(null);
  const [draft, setDraft] = useState<Note>({ body: "", version: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [serverCopy, setServerCopy] = useState<Note | null>(null);
  const [inserting, setInserting] = useState(false);
  const [pasteWarning, setPasteWarning] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mediaRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mediaRequest.current?.abort(); }; }, []);
  const dirty = data !== null && draft.body !== data.note.body;
  const bytes = new TextEncoder().encode(draft.body).length;

  useEffect(() => {
    const ac = new AbortController();
    fetch(url, { signal: ac.signal }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "文件加载失败");
      return result as FileData;
    }).then((result) => {
      if (ac.signal.aborted) return;
      setData(result);
      let restored: Note | null = null;
      try {
        const raw = localStorage.getItem(draftKey);
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved.body === "string" && Number.isSafeInteger(saved.version) && saved.version >= 0) restored = saved;
      } catch { setStorageError(true); }
      setDraft(restored ?? result.note);
      if (restored && restored.body !== result.note.body) setMessage("已恢复此文件的未保存草稿");
      setLoading(false);
    }).catch((cause: unknown) => {
      if (ac.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "文件加载失败"); setLoading(false);
    });
    return () => ac.abort();
  }, [url, draftKey]);

  function persist(next: Note) {
    setDraft(next); setMessage("");
    try { localStorage.setItem(draftKey, JSON.stringify(next)); } catch { setStorageError(true); }
  }
  async function insertContent(text: string, start: number, end: number) {
    if (!mounted.current || mediaRequest.current) return;
    const ac = new AbortController(); mediaRequest.current = ac;
    setInserting(true); setError("");
    try {
      const sources = [...new Set(text.match(/data:(?:application\/x-code-atlas-layout|image\/(?:png|jpeg|webp|gif));base64,[A-Za-z0-9+/=]+/g) ?? [])];
      for (const src of sources) {
        const response = await fetch(`/api/projects/${projectId}/note-media`, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ src, fileId: file.id, path: file.path, revision }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "保存附件失败");
        text = text.replaceAll(src, result.url);
      }
      if (ac.signal.aborted) return;
      const body = draft.body.slice(0, start) + text + draft.body.slice(end);
      if (new TextEncoder().encode(body).length > 32768) throw new Error("追加后的笔记超过 32KB，请缩小选择范围或分到其他文件笔记。");
      persist({ ...draft, body });
      if (sources.length) { setPreviewOpen(true); setPasteWarning(""); }
      requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(start + text.length, start + text.length); });
    } catch (cause) {
      if (!ac.signal.aborted) setError(cause instanceof Error ? cause.message : "插入附件失败");
    } finally { if (!ac.signal.aborted) { setInserting(false); mediaRequest.current = null; } }
  }
  async function insertImage(image: File, start: number, end: number) {
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(image.type) || image.size > NOTE_IMAGE_MAX_BYTES) { setError("请选择 1MB 以内的 PNG、JPEG、WebP 或 GIF 图片"); return; }
    setInserting(true);
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(image);
      });
      const label = image.name.replace(/[\\[\]\r\n]/g, " ").slice(0, 80) || "截图";
      await insertContent(`\n\n![${label}](${src})\n\n`, start, end);
    } catch { if (mounted.current) { setError("图片读取失败，请重试"); setInserting(false); } }
  }
  async function save() {
    if (!data || saving || inserting || bytes > 32768 || !dirty) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, path: file.path, revision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "保存失败，请保留草稿后重试");
      setData({ ...data, note: result }); setDraft(result); setMessage("已保存"); setServerCopy(null);
      try { localStorage.removeItem(draftKey); } catch { setStorageError(true); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请保留草稿后重试"); }
    finally { setSaving(false); }
  }
  async function showSaved() {
    try {
      const response = await fetch(url);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "加载失败");
      setServerCopy(result.note);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }

  return <ResizablePanels>
    <section className="flex min-h-0 min-w-0 flex-col border-r border-slate-800">
      <div className="atlas-toolbar shrink-0 border-b border-slate-800 px-4 py-3 text-sm text-slate-300" title={file.path}><span className="block truncate">{file.path}</span></div>
      <div className="min-h-0 flex-1">{data ? <CodeViewer content={data.file.content} language={data.file.language} fileKey={`file:${file.id}`} range={{ startLine: 1, endLine: data.file.lineCount }} mode="file" refs={[]} highlight={null} onRefClick={() => {}} /> : <p className="p-6 text-sm text-slate-500">{loading ? "正在加载源码…" : error}</p>}</div>
    </section>
    <section aria-label="文件笔记" className="flex min-h-0 min-w-0 flex-col bg-slate-950/40">
      <div className="atlas-toolbar flex shrink-0 items-center gap-3 border-b border-slate-800 px-4 py-2">
        <h2 className="flex-1 text-sm font-medium text-slate-100">文件笔记</h2>
        <span className="text-xs text-slate-500">{saving ? "正在保存…" : dirty ? "未保存" : data ? "已保存" : ""}</span>
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择笔记图片" className="hidden" onChange={(event) => { const image = event.target.files?.[0]; if (image) void insertImage(image, textarea.current?.selectionStart ?? draft.body.length, textarea.current?.selectionEnd ?? draft.body.length); event.target.value = ""; }} />
        <button disabled={!data || saving || inserting} onMouseDown={(event) => event.preventDefault()} onClick={() => imageInput.current?.click()} className="text-xs text-indigo-300 disabled:opacity-50">插入图片</button>
        <button disabled={!data || !dirty || saving || inserting || bytes > 32768} onClick={save} className="rounded-md bg-indigo-500/20 px-3 py-1.5 text-sm text-indigo-200 disabled:opacity-50">保存笔记</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="break-all text-xs text-slate-500">{file.path}</p>
        <label className="block text-sm text-slate-400">笔记正文
          <textarea ref={textarea} aria-label="文件笔记正文" disabled={loading || saving || inserting || !data} value={draft.body}
            placeholder="在这里粘贴 AI 回复或输入笔记，可继续追加和编辑…"
            onChange={(event) => persist({ ...draft, body: event.target.value })}
            onPaste={(event) => {
              const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd;
              const image = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
              const enhanced = /data-code-atlas-copy=["']1["']/i.test(event.clipboardData.getData("text/html"));
              if (image && !enhanced) { event.preventDefault(); void insertImage(image, start, end); return; }
              const text = fileNoteClipboard(event.clipboardData);
              if (!text) return;
              const plain = event.clipboardData.getData("text/plain");
              setPasteWarning(notePasteWarning(text));
              if (text === plain) return;
              event.preventDefault();
              void insertContent(text, start, end);
            }}
            onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void save(); } }}
            className="mt-2 min-h-72 w-full resize-y rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-sm leading-6 text-slate-100 outline-none focus:border-indigo-400 disabled:opacity-50" />
        </label>
        <p className={`text-xs ${bytes > 32768 ? "text-rose-300" : "text-slate-500"}`}>{bytes.toLocaleString()} / 32,768 字节 · Ctrl/⌘+Enter 保存</p>
        {storageError && <p role="alert" className="text-xs text-amber-300">浏览器草稿存储不可用，请保存后再离开页面。</p>}
        {inserting && <p role="status" className="text-xs text-slate-400">正在保存笔记附件…</p>}
        {pasteWarning && <p role="status" className="text-xs text-amber-300">{pasteWarning}</p>}
        {error && <div role="alert" className="text-sm text-rose-300">{error}{data && <button onClick={showSaved} className="ml-2 underline">查看已保存版本</button>}</div>}
        {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
        <details open={previewOpen} onToggle={(event) => setPreviewOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm text-slate-400">预览</summary><FileNoteMarkdown text={draft.body} /></details>
        {serverCopy && <div className="space-y-2 border-t border-slate-700 pt-3"><h3 className="text-sm">已保存版本 v{serverCopy.version}（本地草稿保留）</h3><FileNoteMarkdown text={serverCopy.body} />
          <button className="text-xs text-indigo-300 underline" onClick={() => { persist({ ...draft, version: serverCopy.version }); setData(data ? { ...data, note: serverCopy } : null); setServerCopy(null); setMessage("草稿已保留，再次保存将更新刚查看的版本"); }}>保留本地内容，继续编辑</button>
        </div>}
      </div>
    </section>
  </ResizablePanels>;
}
