"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Markdown } from "./Markdown";
import { NOTE_STATES, parseNoteContent, type NoteContent, type NoteList, type NoteView } from "@/lib/note-types";
interface Props {
  projectId: number; createdAt: string; revision: number; symbolId?: number; symbolName?: string; quote?: string | null;
  onOpen: (id: number, start: number | null, end: number | null, revision: number) => void;
}
interface Draft { id: string; version?: number; symbolId?: number; revision: number; quote?: string | null; copyFrom?: string; tagsInput?: string; content: NoteContent }
const CHANGE = "code-atlas:note-draft";
function subscribe(callback: () => void) { window.addEventListener("storage", callback); window.addEventListener(CHANGE, callback); return () => { window.removeEventListener("storage", callback); window.removeEventListener(CHANGE, callback); }; }
function readDraft(raw: string | null): Draft | null {
  try {
    if (!raw || raw.length > 150000) return null;
    const value = JSON.parse(raw);
    // An empty title is valid in a draft, but must be filled before saving.
    if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/i.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1) ||
      value.symbolId !== undefined && (!Number.isSafeInteger(value.symbolId) || value.symbolId < 1) ||
      value.quote != null && (typeof value.quote !== "string" || value.quote.length > 6000) ||
      !value.content || typeof value.content.title !== "string" || value.content.title.length > 120 || typeof value.content.body !== "string" || value.content.body.length > 65536 ||
      !Array.isArray(value.content.tags) || value.content.tags.length > 100 || !value.content.tags.every((t: unknown) => typeof t === "string" && t.length <= 1000) ||
      !Object.hasOwn(NOTE_STATES, value.content.status)) return null;
    return value;
  } catch { return null; }
}
export function NotesPanel(props: Props) {
  const { projectId, createdAt, revision, symbolId, symbolName, quote, onOpen } = props;
  const [page, setPage] = useState(0), [trash, setTrash] = useState(false), [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<{ key: string; data?: NoteList; error?: string } | null>(null);
  const [editor, setEditor] = useState<Draft | null>(null), [serverCopy, setServerCopy] = useState<NoteView | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const storageKey = `code-atlas:note-draft:v1:${projectId}:${createdAt}`;
  const raw = useSyncExternalStore(subscribe, () => { try { return localStorage.getItem(storageKey); } catch { return null; } }, () => null);
  const draft = readDraft(raw), key = `${projectId}:${page}:${trash}`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/projects/${projectId}/notes?page=${page}&trash=${trash ? 1 : 0}`, { signal: controller.signal }).then(async (r) => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "笔记加载失败"); return data as NoteList;
    }).then((data) => { if (!controller.signal.aborted) setList({ key, data }); }).catch((e) => { if (!controller.signal.aborted) setList({ key, error: e instanceof Error ? e.message : "笔记加载失败" }); });
    return () => controller.abort();
  }, [projectId, page, trash, key, attempt]);
  const shown = list?.key === key ? list : null;
  function persist(value: Draft) {
    setEditor(value);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); window.dispatchEvent(new Event(CHANGE)); }
    catch { setMessage("浏览器无法保存草稿，请保持本页打开并保存到数据库"); }
  }
  function clearDraft(value?: Draft) {
    try { if (!value || localStorage.getItem(storageKey) === JSON.stringify(value)) localStorage.removeItem(storageKey); window.dispatchEvent(new Event(CHANGE)); }
    catch { setMessage("无法清除浏览器草稿"); }
  }
  async function request(body: object): Promise<NoteView> {
    const r = await fetch(`/api/projects/${projectId}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "保存失败"); return data;
  }
  async function act(task: () => Promise<void>) {
    if (busy) return; setBusy(true); setMessage("");
    try { await task(); } catch (e) { setMessage(e instanceof Error ? e.message : "笔记操作失败，请保留草稿重试"); } finally { setBusy(false); }
  }
  function start(note?: NoteView) {
    if (editor || draft) { setMessage("已有未保存草稿，请先恢复并保存，或明确清除草稿"); return; }
    setServerCopy(null);
    persist(note ? { id: note.id, version: note.version, revision, content: { title: note.title, body: note.body, tags: note.tags, status: note.status } }
      : { id: crypto.randomUUID(), revision, symbolId, quote, content: { title: symbolName ? `${symbolName} 学习笔记`.slice(0, 120) : "", body: "", tags: [], status: "reading" } });
  }
  async function save(copy = false) {
    if (!editor) return;
    const content = parseNoteContent(editor.content); if (!content) { setMessage("请填写标题并检查内容限额"); return; }
    let saving = editor;
    if (copy) { saving = { ...editor, id: crypto.randomUUID(), version: undefined, copyFrom: editor.id }; persist(saving); }
    let note: NoteView;
    try { note = await request({ ...saving, content, action: saving.version ? "update" : "create" }); }
    catch (error) { persist(saving); throw error; }
    clearDraft(saving); setEditor(null); setServerCopy(null); setAttempt((n) => n + 1);
    setMessage(note.anchor ? "笔记已保存" : "笔记已保存为项目笔记；源码快照变化时不会猜测绑定目标");
  }
  const inputClass = "w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm";
  return <section aria-label="个人学习笔记" className="space-y-4 p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">个人学习笔记</h2><button disabled={busy} onClick={() => start()} className="atlas-primary px-3 py-2 text-xs">{quote ? "新建选区笔记" : symbolId ? "新建节点笔记" : "新建项目笔记"}</button></div>
    {message && <p role="status" className="break-words rounded border border-slate-700 p-2 text-xs leading-5">{message}</p>}
    {draft && !editor && <div className="flex flex-wrap gap-2 text-xs"><span>有未保存草稿：{draft.content.title || "未命名"}</span><button className="underline" onClick={() => { setServerCopy(null); setEditor(draft); }}>恢复草稿</button><button className="underline" onClick={() => clearDraft()}>清除草稿</button></div>}
    {editor && <form className="space-y-3 rounded border border-slate-700 p-3" onSubmit={(e) => { e.preventDefault(); void act(() => save()); }} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void act(() => save()); } }}>
      <fieldset disabled={busy} className="space-y-3">
      <p className="text-xs text-slate-400">未保存草稿 · 每次编辑保存在本浏览器，点击保存后写入数据库。每个项目保留一个草稿。</p>
      <label className="block">笔记标题<input required maxLength={120} value={editor.content.title} onChange={(e) => persist({ ...editor, content: { ...editor.content, title: e.target.value } })} className={inputClass} /></label>
      <label className="block">学习状态<select value={editor.content.status} onChange={(e) => persist({ ...editor, content: { ...editor.content, status: e.target.value as NoteContent["status"] } })} className={inputClass}>{Object.entries(NOTE_STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="block">标签（逗号分隔，最多 10 个）<input value={editor.tagsInput ?? editor.content.tags.join(",")} onChange={(e) => persist({ ...editor, tagsInput: e.target.value, content: { ...editor.content, tags: e.target.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean) } })} className={inputClass} /></label>
      {editor.quote && <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{editor.quote}</pre>}
      <label className="block">笔记正文（Markdown，最多 32KB）<textarea rows={9} maxLength={65536} value={editor.content.body} onChange={(e) => persist({ ...editor, content: { ...editor.content, body: e.target.value } })} className={inputClass} /></label>
      <details><summary>预览</summary><Markdown text={editor.content.body} /></details>
      <div className="flex flex-wrap gap-3 text-xs"><button disabled={busy} className="atlas-primary px-3 py-2">保存笔记</button><button disabled={busy} type="button" className="underline" onClick={() => { setEditor(null); setServerCopy(null); }}>返回列表（保留草稿）</button>
        {editor.version && <><button type="button" disabled={busy} className="underline" onClick={() => act(async () => {
          const r = await fetch(`/api/projects/${projectId}/notes?noteId=${editor.id}`), data = await r.json(); if (!r.ok) throw new Error(data.error); setServerCopy(data);
        })}>查看服务器版本</button><button type="button" disabled={busy} className="underline" onClick={() => act(() => save(true))}>另存副本</button></>}
      </div>
      {serverCopy && <div className="space-y-2 border-t border-slate-700 pt-3"><h3>服务器版本 v{serverCopy.version}（本地草稿保留）</h3><Markdown text={serverCopy.body} /><button type="button" className="text-xs underline" onClick={() => { persist({ ...editor, version: serverCopy.version }); setServerCopy(null); setMessage("本地内容已保留；再次保存将更新刚刚查看的服务器版本"); }}>保留本地内容，继续编辑</button></div>}
      </fieldset>
    </form>}
    <div className="flex gap-3 text-xs"><button aria-pressed={!trash} onClick={() => { setTrash(false); setPage(0); }}>笔记列表</button><button aria-pressed={trash} onClick={() => { setTrash(true); setPage(0); }}>回收站</button></div>
    {!shown ? <p role="status">正在加载笔记…</p> : shown.error ? <p role="alert">{shown.error}<button className="ml-2 underline" onClick={() => setAttempt((n) => n + 1)}>重试</button></p> : <>
      <p className="text-xs text-slate-400">共 {shown.data?.total ?? 0} 篇 · 第 {page + 1} 页 · 项目内笔记集中展示</p>
      <ul className="space-y-3">{shown.data?.items.map((note) => <li key={note.id} className="space-y-2 rounded border border-slate-700 p-3">
        <h3 className="break-words font-semibold">{note.title}</h3><p className="break-words text-xs text-slate-400">{NOTE_STATES[note.status]} · v{note.version} · {note.tags.join("、")}</p>
        {note.anchor && <p className="break-all text-xs text-slate-400">{note.anchor.path} · {note.anchor.name} · {note.resolution?.status === "missing" ? "节点已删除或移动" : note.resolution?.status === "ambiguous" ? "同名目标待确认" : note.resolution?.freshness === "changed" ? "源码已变化，请核对" : "源码未变化"}</p>}
        <details><summary className="text-xs">阅读笔记</summary><Markdown text={note.body} />{note.quote && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">原引用：{note.quote.text}</pre>}</details>
        <div className="flex flex-wrap gap-3 text-xs">{!trash && <button disabled={busy} onClick={() => start(note)} className="underline">编辑笔记</button>}
          {note.resolution?.symbolId && (!note.quote || note.quoteStartLine !== null) && <button disabled={busy} className="underline" onClick={() => onOpen(note.resolution!.symbolId!, note.quoteStartLine, note.quoteEndLine, shown.data!.revision)}>定位源码</button>}
          <button disabled={busy} className="underline" onClick={() => act(async () => { await request({ action: trash ? "restore" : "trash", id: note.id, version: note.version }); setAttempt((n) => n + 1); })}>{trash ? "恢复笔记" : "移入回收站"}</button>
        </div>
      </li>)}</ul>
      {shown.data?.total === 0 && <p className="text-slate-400">{trash ? "回收站为空" : "还没有笔记，可从当前节点或项目开始记录。"}</p>}
      <div className="flex gap-3 text-xs"><button disabled={page === 0} onClick={() => setPage((n) => n - 1)}>上一页</button><button disabled={(page + 1) * 20 >= (shown.data?.total ?? 0)} onClick={() => setPage((n) => n + 1)}>下一页</button></div>
    </>}
  </section>;
}
