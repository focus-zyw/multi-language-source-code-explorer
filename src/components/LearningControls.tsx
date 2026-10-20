"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { readReadingPosition, type AnchorResolution, type LearningAnchor, type LearningSnapshot, type ReadingPosition } from "@/lib/learning-types";

interface Props {
  projectId: number; createdAt: string; revision: number; selectedId: number | null; rootId: number | null;
  overview: boolean; view: "source" | "explore"; direction: "incoming" | "outgoing"; tab: string; mode: "method" | "file";
  onRestore: (selected: number, root: number | null, position: ReadingPosition | null, reload: boolean) => void;
}
const EVENT = "code-atlas:position-changed";
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback); window.addEventListener(EVENT, callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener(EVENT, callback); };
}
const STATUS = { missing: "节点已删除或移动", ambiguous: "同名节点无法唯一匹配", resolved: "" };
export function LearningControls(props: Props) {
  const { projectId, createdAt, revision, selectedId, rootId, overview, view, direction, tab, mode } = props;
  const [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<{ key: string; data?: LearningSnapshot; error?: string } | null>(null);
  const key = `${projectId}:${createdAt}:${revision}:${selectedId}:${rootId}:${overview}:${open}`;
  const storageKey = `code-atlas:position:v1:${projectId}`;
  const raw = useSyncExternalStore(subscribe, () => { try { return localStorage.getItem(storageKey); } catch { return null; } }, () => null);
  const last = readReadingPosition(raw, createdAt);
  const current = state?.key === key ? state : null;
  useEffect(() => {
    const controller = new AbortController(), query = new URLSearchParams();
    if (selectedId !== null && !overview) query.set("symbolId", String(selectedId));
    if (rootId !== null && !overview) query.set("rootId", String(rootId));
    if (open) query.set("list", "1");
    fetch(`/api/projects/${projectId}/learning?${query}`, { signal: controller.signal }).then(async (r) => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "学习记录加载失败"); return data as LearningSnapshot;
    }).then((data) => { if (!controller.signal.aborted) setState({ key, data }); })
      .catch((error) => { if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "学习记录加载失败" }); });
    return () => controller.abort();
  }, [projectId, selectedId, rootId, overview, open, key, attempt]);
  const captured = current?.data;
  useEffect(() => {
    if (!captured?.selected || captured.revision !== revision || overview) return;
    const position: ReadingPosition = { version: 1, projectCreatedAt: createdAt, revision, selected: captured.selected,
      root: captured.root, view, direction, tab, mode };
    try { localStorage.setItem(storageKey, JSON.stringify(position)); window.dispatchEvent(new Event(EVENT)); }
    catch { queueMicrotask(() => setMessage("浏览器存储不可用，无法记住阅读位置；数据库书签仍可使用")); }
  }, [captured, revision, overview, storageKey, createdAt, view, direction, tab, mode]);

  async function post(body: object) {
    const response = await fetch(`/api/projects/${projectId}/learning`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "操作失败"); return data;
  }
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function restore(anchor: LearningAnchor, position: ReadingPosition | null) {
    const result = await post({ action: "resolve", anchors: [anchor, ...(position?.root ? [position.root] : [])] }) as { revision: number; anchors: AnchorResolution[] };
    const [selected, root] = result.anchors;
    if (selected.symbolId === null) { setMessage(STATUS[selected.status] || "阅读位置已失效"); return; }
    const warnings = [selected.freshness === "changed" ? "源码内容已变化，请重新核对" : "", position?.root && !root?.symbolId ? "探索起点失效，已恢复源码阅读" : ""];
    props.onRestore(selected.symbolId, root?.symbolId ?? null, position, result.revision !== revision);
    setMessage(warnings.filter(Boolean).join("；")); setOpen(warnings.some(Boolean));
  }
  return <div className="relative flex items-center gap-2 text-xs">
    {selectedId !== null && !overview && <button disabled={busy || !captured?.selected || captured.revision !== revision} onClick={() => act(async () => {
      await post({ action: "bookmark", symbolId: selectedId, revision }); setMessage("书签已保存"); setAttempt((n) => n + 1);
    })} className="rounded border border-slate-700 px-2.5 py-1 disabled:opacity-50">收藏当前节点</button>}
    <button aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rounded border border-slate-700 px-2.5 py-1">书签 / 继续阅读</button>
    {open && <section aria-label="学习记录" className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">学习记录</h2><button onClick={() => setOpen(false)} aria-label="关闭学习记录">关闭</button></div>
      {last ? <button disabled={busy} onClick={() => act(() => restore(last.selected, last))} className="mt-3 w-full rounded border border-slate-700 p-3 text-left"><span className="block text-indigo-300">继续上次阅读 · {last.selected.name}</span><span className="mt-1 block break-all text-slate-400">{last.selected.path} · {last.view === "explore" ? "流程探索" : "源码阅读"}</span></button> : <p className="mt-3 text-slate-400">本浏览器还没有保存的阅读位置。选择节点阅读后会自动记录。</p>}
      <h3 className="mt-4 font-semibold">项目书签</h3>
      {!current ? <p role="status" className="mt-2">正在加载…</p> : current.error ? <p role="alert" className="mt-2 text-rose-300">{current.error}<button className="ml-2 underline" onClick={() => setAttempt((n) => n + 1)}>重试</button></p> : <ul className="mt-2 space-y-2">{current.data?.bookmarks.map((bookmark) => <li key={bookmark.id} className="rounded border border-slate-700 p-2">
        <button disabled={busy || bookmark.status !== "resolved"} onClick={() => act(() => restore(bookmark.anchor, null))} className="w-full break-all text-left text-indigo-300 disabled:text-slate-500">{bookmark.anchor.name}<span className="mt-1 block text-slate-400">{bookmark.anchor.path}{bookmark.line ? `:L${bookmark.line}` : ""}</span></button>
        <div className="mt-2 flex items-center justify-between gap-2"><span className="text-slate-400">{STATUS[bookmark.status] || (bookmark.freshness === "changed" ? "内容已变化，请核对" : "与收藏时源码一致")}</span><button disabled={busy} className="shrink-0 underline" onClick={() => act(async () => { await post({ action: "remove", bookmarkId: bookmark.id }); setAttempt((n) => n + 1); })}>取消收藏</button></div>
      </li>)}</ul>}
      {current?.data?.bookmarks.length === 0 && <p className="mt-2 text-slate-400">暂无书签。在源码或探索视图收藏当前节点。</p>}
      <p className="mt-3 leading-5 text-slate-500">书签保存在本机数据库，每个项目最多 200 项。阅读位置仅在本浏览器保存；恢复时重新定位。重扫后不恢复旧调用树展开路径。</p>
    </section>}
    {message && <div role="status" className="absolute right-0 top-full z-[60] mt-1 w-72 rounded border border-slate-700 bg-slate-900 p-2 text-slate-200">{message}<button className="ml-2 underline" onClick={() => setMessage("")}>关闭</button></div>}
  </div>;
}
