"use client";
import { useEffect, useState } from "react";
import type { NoteConnections as Connections, NoteView } from "@/lib/note-types";
export function NoteConnections({ projectId, note, onNavigate, onClose }: {
  projectId: number; note: NoteView; onNavigate: (id: string) => void; onClose: () => void;
}) {
  const [data, setData] = useState<Connections | null>(null), [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState(""), [label, setLabel] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const url = `/api/projects/${projectId}/notes`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${url}?links=${encodeURIComponent(note.id)}`, { signal: controller.signal }).then(async (r) => {
      const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "关联加载失败"); return body as Connections;
    }).then((value) => { if (!controller.signal.aborted) setData(value); }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "关联加载失败"); });
    return () => controller.abort();
  }, [url, note.id, attempt]);
  async function mutate(action: "link" | "unlink", targetId: string) {
    if (busy) return; setBusy(true); setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, source: note.id, target: targetId, label }) });
      const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "关联保存失败");
      setAttempt((v) => v + 1); setTarget(""); setLabel("");
    } catch (e) { setError(e instanceof Error ? e.message : "关联保存失败"); } finally { setBusy(false); }
  }
  return <section aria-label="笔记关联" className="space-y-3 rounded border border-slate-700 p-3 text-xs">
    <div className="flex justify-between gap-3"><h3 className="break-words font-semibold">关联：{note.title}</h3><button onClick={onClose}>关闭关联</button></div>
    <p className="text-slate-400">关联描述学习关系，不代表代码调用顺序。删除笔记后保留关联，恢复后继续可用。</p>
    {error && <p role="alert">{error}<button className="ml-2 underline" onClick={() => { setError(""); setAttempt((n) => n + 1); }}>重试加载</button></p>}
    {!data ? <p role="status">正在加载关联…</p> : <>
      {(["outgoing", "incoming"] as const).map((direction) => <div key={direction}><h4 className="font-semibold">{direction === "outgoing" ? "此篇关联到" : "哪些笔记关联到此篇"}</h4>
        {!data[direction].length && <p className="py-1 text-slate-400">暂无关联</p>}
        <ul className="space-y-2 py-2">{data[direction].map((link) => <li key={link.id} className="break-words"><button className="underline" onClick={() => onNavigate(link.id)}>{link.title}{link.deleted ? "（回收站）" : ""}</button>{link.label && <span> · {link.label}</span>}
          {direction === "outgoing" && <button disabled={busy} className="ml-3 underline" onClick={() => mutate("unlink", link.id)}>移除关联</button>}</li>)}</ul></div>)}
      {note.deletedAt === null && <form onSubmit={(e) => { e.preventDefault(); void mutate("link", target); }}><fieldset disabled={busy} className="space-y-2">
        <label className="block">关联到笔记<select required value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2"><option value="">选择目标笔记</option>{data.choices.map((n) => <option key={n.id} value={n.id}>{n.title} · {n.id.slice(0, 8)}</option>)}</select></label>
        <label className="block">关联说明<input maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：建议先读、设计原因" className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2" /></label>
        <button disabled={!target || busy} className="atlas-primary px-3 py-2">添加关联</button>
      </fieldset></form>}
    </>}
  </section>;
}
