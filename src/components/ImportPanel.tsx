"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IGNORED_DIRS, LIMITS, classifyPath, commonRoot, normalizeEntryPath } from "@/lib/ingest/rules";
import { SKIP_REASON_LABELS } from "@/lib/shared";
import type { LocalFolderListing } from "@/lib/api-types";
import { LocalFolderPicker } from "./LocalFolderPicker";
import { LANGUAGE_LABELS } from "@/lib/languages";

interface FolderItem {
  file: File;
  path: string;
}

interface LocalPreview {
  sourcePath: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  samplePaths: string[];
  skipped: Record<string, number>;
}

type Picked =
  | { kind: "zip"; file: File }
  | { kind: "folder"; label: string; items: FolderItem[]; skipped: Record<string, number>; totalBytes: number };

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

/** 与服务端相同的规则做预过滤，减少上传量；服务端会强制重新校验 */
function prefilter(raw: FolderItem[], extraSkipped: Record<string, number> = {}): Picked & { kind: "folder" } {
  const skipped: Record<string, number> = { ...extraSkipped };
  const valid: FolderItem[] = [];
  for (const it of raw) {
    const c = normalizeEntryPath(it.path);
    if (!c.ok) bump(skipped, c.reason);
    else valid.push({ file: it.file, path: c.path });
  }
  const root = commonRoot(valid.map((v) => v.path));
  const items: FolderItem[] = [];
  let totalBytes = 0;
  for (const v of valid) {
    const p = root ? v.path.slice(root.length + 1) : v.path;
    const reason = classifyPath(p);
    if (reason) {
      bump(skipped, reason);
      continue;
    }
    if (v.file.size > LIMITS.maxFileBytes) {
      bump(skipped, "too-large");
      continue;
    }
    items.push({ file: v.file, path: v.path });
    totalBytes += v.file.size;
  }
  return { kind: "folder", label: root ?? "文件夹", items, skipped, totalBytes };
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: FolderItem[], skipped: Record<string, number>): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    if (IGNORED_DIRS.has(entry.name)) {
      bump(skipped, "ignored-dir");
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, `${prefix}${entry.name}/`, out, skipped);
    }
  }
}

function fmtBytes(n: number) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function ImportPanel() {
  const router = useRouter();
  const [mode, setMode] = useState<"local" | "upload">("local");
  const [localPath, setLocalPath] = useState("");
  const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
  const [folderPicker, setFolderPicker] = useState<LocalFolderListing | null>(null);
  const localPending = useRef(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);

  const localAction = async (action: "preview" | "import", selectedPath?: string) => {
    if (localPending.current) return;
    const target = selectedPath ?? localPath;
    if (!target.trim()) { setError("请输入本地项目的绝对路径"); return; }
    localPending.current = true;
    setError(null);
    setBusy(action === "preview" ? "正在检查本地目录…" : "正在读取本地源码并分析…");
    try {
      const response = await fetch("/api/projects/local", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, path: action === "import" ? localPreview?.sourcePath ?? target : target, name: name.trim() }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `操作失败（HTTP ${response.status}）`);
      if (action === "preview") {
        setLocalPath(body.sourcePath);
        setLocalPreview(body as LocalPreview);
      } else {
        router.push(`/p/${body.id}`);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法读取本地目录");
    } finally { localPending.current = false; setBusy(null); }
  };

  const openFolderPicker = async () => {
    if (localPending.current) return;
    localPending.current = true;
    setBusy("正在打开文件夹选择…");
    setError(null);
    try {
      const response = await fetch("/api/projects/local/folders", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: localPreview?.sourcePath }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "无法打开文件夹选择");
      setFolderPicker(body);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法打开文件夹选择");
    } finally { localPending.current = false; setBusy(null); }
  };

  const onFolder = (list: FileList | null) => {
    if (!list || !list.length) return;
    setError(null);
    const raw: FolderItem[] = Array.from(list).map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));
    setPicked(prefilter(raw));
  };

  const onZip = (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    setError(null);
    if (!/\.zip$/i.test(f.name)) return setError("请选择 .zip 文件");
    if (f.size > LIMITS.maxZipBytes) return setError("ZIP 超过 100MB 上限");
    setPicked({ kind: "zip", file: f });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setError(null);
    const items = Array.from(e.dataTransfer.items ?? []);
    const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null).filter((x): x is FileSystemEntry => x !== null);
    if (entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) {
      return onZip(e.dataTransfer.files);
    }
    if (!entries.length) return setError("无法读取拖入的内容，请使用下方按钮选择");
    setBusy("正在读取文件夹…");
    try {
      const out: FolderItem[] = [];
      const skipped: Record<string, number> = {};
      for (const en of entries) await walkEntry(en, "", out, skipped);
      setPicked(prefilter(out, skipped));
    } catch {
      setError("读取拖入的文件夹失败");
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!picked) return;
    setError(null);
    setBusy("正在上传并解析（大型项目可能需要几十秒）…");
    try {
      const fd = new FormData();
      if (name.trim()) fd.set("name", name.trim());
      if (picked.kind === "zip") {
        fd.set("mode", "zip");
        fd.set("file", picked.file);
      } else {
        if (!picked.items.length) throw new Error("没有可导入的源码文件");
        if (picked.totalBytes > LIMITS.maxUploadBytes) throw new Error("源码总量超过上传上限");
        fd.set("mode", "folder");
        fd.set("paths", JSON.stringify(picked.items.map((i) => i.path)));
        fd.set("clientSkipped", JSON.stringify(picked.skipped));
        for (const it of picked.items) fd.append("files", it.file, it.file.name);
      }
      const res = await fetch("/api/projects", { method: "POST", body: fd });
      const json = (await res.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!res.ok || !json.id) throw new Error(json.error ?? `导入失败（HTTP ${res.status}）`);
      router.push(`/p/${json.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
      setBusy(null);
    }
  };

  const skippedEntries = picked?.kind === "folder" ? Object.entries(picked.skipped).filter(([, v]) => v > 0) : [];

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl">
      <h2 className="text-base font-semibold text-slate-100">导入源码项目</h2>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        支持 {Object.values(LANGUAGE_LABELS).join(" / ")}。仅做静态语法解析，<b className="text-slate-200">不会执行</b>项目中的任何代码；
        node_modules、.git、二进制与超大文件会被自动跳过。
      </p>

      <div className="mt-4 flex gap-2" role="group" aria-label="导入方式">
        <button type="button" disabled={!!busy} aria-pressed={mode === "local"} onClick={() => { setMode("local"); setError(null); }}
          className={`rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50 ${mode === "local" ? "bg-indigo-500 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>本地路径</button>
        <button type="button" disabled={!!busy} aria-pressed={mode === "upload"} onClick={() => { setMode("upload"); setError(null); }}
          className={`rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50 ${mode === "upload" ? "bg-indigo-500 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>上传文件夹 / ZIP</button>
      </div>

      {mode === "local" && <div className="mt-4 space-y-3 rounded-xl bg-slate-950/40 p-4">
        <div>
          <label htmlFor="local-source-path" className="mb-1.5 block text-sm text-slate-200">本地项目路径</label>
          <div className="flex flex-col gap-2 sm:flex-row">
          <input id="local-source-path" value={localPath} disabled={!!busy} autoComplete="off" spellCheck={false}
            placeholder="例如 D:/projects/my-app" onChange={(event) => { setLocalPath(event.target.value); setLocalPreview(null); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void localAction("preview"); } }}
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-indigo-400 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50" />
          <button type="button" disabled={!!busy} onClick={openFolderPicker} className="shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:border-indigo-400 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50">选择文件夹</button>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-slate-400">可直接选择本机文件夹，或填写路径。选好后自动预览，无需上传。</p>
        </div>
        <button type="button" disabled={!!busy} onClick={() => localAction("preview")}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-indigo-400 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50">
          {localPreview ? "重新预览目录" : "预览目录"}
        </button>
        {localPreview && <div className="space-y-3 border-t border-slate-800 pt-3">
          <p className="break-all font-mono text-xs text-indigo-300">{localPreview.sourcePath}</p>
          <p className="text-sm text-slate-200">找到 <b>{localPreview.fileCount}</b> 个受支持源码文件（{fmtBytes(localPreview.totalBytes)}）</p>
          {Object.keys(localPreview.skipped).length > 0 && <p className="text-xs leading-5 text-slate-400">已跳过：{Object.entries(localPreview.skipped).map(([reason, count]) => `${SKIP_REASON_LABELS[reason]?.split("（")[0] ?? reason} ${count}`).join("，")}</p>}
          {localPreview.samplePaths.length > 0 && <details className="text-xs text-slate-400">
            <summary className="cursor-pointer text-indigo-300">查看文件示例</summary>
            <ul className="mt-2 space-y-1 break-all font-mono">{localPreview.samplePaths.map((path) => <li key={path}>{path}</li>)}</ul>
          </details>}
          <p className="text-xs leading-5 text-slate-500">预览按路径和大小统计；二进制、编码等内容检查会在分析时执行。</p>
          {localPreview.fileCount ? <>
            <label htmlFor="local-project-name" className="block text-xs text-slate-300">项目名称（可选）</label>
            <input id="local-project-name" value={name} disabled={!!busy} maxLength={120} placeholder={localPreview.name}
              onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-400 focus-visible:outline-2 focus-visible:outline-indigo-400" />
            <button type="button" onClick={() => localAction("import")} disabled={!!busy}
              className="w-full rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50">导入本地项目并分析</button>
          </> : <p className="text-sm text-amber-200">未找到可分析的源码，请更换项目目录后重新预览。</p>}
        </div>}
      </div>}

      {mode === "upload" && <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-4 rounded-xl border-2 border-dashed p-6 text-center transition ${dragging ? "border-indigo-400 bg-indigo-500/10" : "border-slate-700 bg-slate-950/40"}`}
      >
        <p className="text-sm text-slate-300">把项目文件夹或 .zip 拖到这里</p>
        <p className="mt-1 text-xs text-slate-500">或</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => folderRef.current?.click()}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            选择文件夹
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => zipRef.current?.click()}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            选择 ZIP
          </button>
        </div>
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            onFolder(e.target.files);
            e.target.value = "";
          }}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
        <input
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            onZip(e.target.files);
            e.target.value = "";
          }}
        />
      </div>}

      {mode === "upload" && picked && (
        <div className="mt-4 space-y-3 rounded-xl bg-slate-950/60 p-4 text-sm">
          {picked.kind === "zip" ? (
            <p className="text-slate-200">
              已选择 ZIP：<span className="font-mono text-indigo-300">{picked.file.name}</span>（{fmtBytes(picked.file.size)}）
              <span className="block text-xs text-slate-500">解压在服务端内存中完成，并校验路径、条目数与压缩比。</span>
            </p>
          ) : (
            <div className="text-slate-200">
              已选择文件夹 <span className="font-mono text-indigo-300">{picked.label}</span>：{" "}
              <b>{picked.items.length}</b> 个受支持源码文件（{fmtBytes(picked.totalBytes)}）
              {skippedEntries.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  已跳过：{skippedEntries.map(([k, v]) => `${SKIP_REASON_LABELS[k]?.split("（")[0] ?? k} ${v}`).join("，")}
                </p>
              )}
              {picked.items.length === 0 && <p className="mt-1 text-xs text-rose-300">未发现 .py / .js / .ts 等受支持的源码文件。</p>}
            </div>
          )}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="项目名称（可选）"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-400"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!!busy || (picked.kind === "folder" && picked.items.length === 0)}
            className="w-full rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            开始导入并分析
          </button>
        </div>
      )}

      {busy && (
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
          {busy}
        </div>
      )}
      {error && <div role="alert" className="mt-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      {folderPicker && <LocalFolderPicker initial={folderPicker} onClose={() => setFolderPicker(null)} onChoose={(path) => {
        setFolderPicker(null);
        setLocalPath(path);
        setLocalPreview(null);
        void localAction("preview", path);
      }} />}
    </div>
  );
}
