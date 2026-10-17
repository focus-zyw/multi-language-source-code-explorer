"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TreeData, TreeFile, TreeSymbol } from "@/lib/api-types";
import { KindIcon } from "./Badges";

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: TreeFile[];
}

function buildDirTree(files: TreeFile[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: p, dirs: new Map(), files: [] };
        cur.dirs.set(parts[i], next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

const LANG_DOT: Record<string, string> = { python: "bg-sky-400", javascript: "bg-yellow-300", typescript: "bg-blue-400" };

type Filter = "all" | "source" | "tests";

export function SymbolTree({ tree, selectedId, onSelect }: { tree: TreeData; selectedId: number | null; onSelect: (id: number) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const dirTree = useMemo(() => buildDirTree(tree.files), [tree.files]);
  const symsByFile = useMemo(() => {
    const m = new Map<number, TreeSymbol[]>();
    for (const s of tree.symbols) {
      const l = m.get(s.fileId) ?? [];
      l.push(s);
      m.set(s.fileId, l);
    }
    return m;
  }, [tree.symbols]);
  const childrenOf = useMemo(() => {
    const m = new Map<number, TreeSymbol[]>();
    for (const s of tree.symbols) {
      if (s.parentId === null) continue;
      const l = m.get(s.parentId) ?? [];
      l.push(s);
      m.set(s.parentId, l);
    }
    return m;
  }, [tree.symbols]);
  const symById = useMemo(() => new Map(tree.symbols.map((s) => [s.id, s])), [tree.symbols]);
  const fileById = useMemo(() => new Map(tree.files.map((f) => [f.id, f])), [tree.files]);

  const [openDirs, setOpenDirs] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const walk = (n: DirNode, depth: number) => {
      if (tree.files.length <= 60 || depth < 2) if (n.path) s.add(n.path);
      for (const d of n.dirs.values()) walk(d, depth + 1);
    };
    walk(dirTree, 0);
    return s;
  });
  const [openFiles, setOpenFiles] = useState<Set<number>>(() => new Set(tree.files.length <= 12 ? tree.files.map((f) => f.id) : []));

  // 选中符号时展开其所在目录/文件并滚动到可见
  useEffect(() => {
    if (selectedId === null) return;
    const sym = symById.get(selectedId);
    const file = sym ? fileById.get(sym.fileId) : null;
    if (!file) return;
    setOpenFiles((prev) => (prev.has(file.id) ? prev : new Set(prev).add(file.id)));
    const parts = file.path.split("/");
    setOpenDirs((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < parts.length - 1; i++) next.add(parts.slice(0, i + 1).join("/"));
      return next;
    });
    const t = setTimeout(() => document.getElementById(`sym-${selectedId}`)?.scrollIntoView({ block: "nearest" }), 60);
    return () => clearTimeout(t);
  }, [selectedId, symById, fileById]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const out: TreeSymbol[] = [];
    for (const s of tree.symbols) {
      const f = fileById.get(s.fileId);
      if (!f) continue;
      if (filter === "source" && f.isTest) continue;
      if (filter === "tests" && !f.isTest) continue;
      if (s.qualifiedName.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) {
        out.push(s);
        if (out.length >= 200) break;
      }
    }
    return out;
  }, [q, tree.symbols, fileById, filter]);

  const toggleDir = (p: string) =>
    setOpenDirs((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const toggleFile = (id: number) =>
    setOpenFiles((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const renderSym = (s: TreeSymbol, depth: number): ReactNode => {
    const kids = childrenOf.get(s.id) ?? [];
    return (
      <Fragment key={s.id}>
        <button
          id={`sym-${s.id}`}
          onClick={() => onSelect(s.id)}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={`flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left text-[13px] hover:bg-slate-800 ${selectedId === s.id ? "bg-indigo-500/25 text-white" : "text-slate-300"}`}
          title={s.qualifiedName}
        >
          <KindIcon kind={s.kind} />
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          <span className="shrink-0 text-[10px] text-slate-600">{s.startLine}</span>
        </button>
        {kids.map((k) => renderSym(k, depth + 1))}
      </Fragment>
    );
  };

  const renderFile = (f: TreeFile, depth: number): ReactNode => {
    if (filter === "source" && f.isTest) return null;
    if (filter === "tests" && !f.isTest) return null;
    const open = openFiles.has(f.id);
    const top = (symsByFile.get(f.id) ?? []).filter((s) => s.parentId === null);
    const count = symsByFile.get(f.id)?.length ?? 0;
    return (
      <div key={f.id}>
        <button
          onClick={() => toggleFile(f.id)}
          style={{ paddingLeft: 8 + depth * 14 }}
          className="flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left text-[13px] text-slate-200 hover:bg-slate-800"
          title={f.path + (f.hasSyntaxErrors ? "（含语法错误，解析可能不完整）" : "")}
        >
          <span className="w-3 text-[10px] text-slate-500">{open ? "▾" : "▸"}</span>
          <span className={`h-2 w-2 shrink-0 rounded-full ${LANG_DOT[f.language] ?? "bg-slate-400"}`} />
          <span className="min-w-0 flex-1 truncate">{f.path.split("/").pop()}</span>
          {f.isTest && <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">test</span>}
          {f.hasSyntaxErrors && <span className="text-[10px] text-amber-400" title="含语法错误">⚠</span>}
          <span className="shrink-0 text-[10px] text-slate-600">{count}</span>
        </button>
        {open && top.map((s) => renderSym(s, depth + 1))}
        {open && top.length === 0 && (
          <div style={{ paddingLeft: 8 + (depth + 1) * 14 }} className="py-1 text-xs text-slate-600">
            （没有函数/类）
          </div>
        )}
      </div>
    );
  };

  const renderDir = (node: DirNode, depth: number): ReactNode => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <Fragment>
        {dirs.map((d) => {
          const open = openDirs.has(d.path);
          return (
            <div key={d.path}>
              <button
                onClick={() => toggleDir(d.path)}
                style={{ paddingLeft: 8 + depth * 14 }}
                className="flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left text-[13px] text-slate-400 hover:bg-slate-800"
              >
                <span className="w-3 text-[10px] text-slate-500">{open ? "▾" : "▸"}</span>
                <span className="truncate">📁 {d.name}</span>
              </button>
              {open && renderDir(d, depth + 1)}
            </div>
          );
        })}
        {node.files.map((f) => renderFile(f, depth))}
      </Fragment>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-slate-800 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索函数 / 方法 / 文件…"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400"
        />
        <div className="flex gap-1">
          {(
            [
              ["all", "全部"],
              ["source", "源码"],
              ["tests", "测试"],
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`flex-1 rounded px-2 py-1 text-xs ${filter === k ? "bg-indigo-500/30 text-indigo-100" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {results ? (
          results.length ? (
            <>
              {results.map((s) => (
                <button
                  key={s.id}
                  id={`sym-${s.id}`}
                  onClick={() => onSelect(s.id)}
                  className={`block w-full rounded px-2 py-1 text-left hover:bg-slate-800 ${selectedId === s.id ? "bg-indigo-500/25" : ""}`}
                >
                  <div className="flex items-center gap-1.5 text-[13px] text-slate-200">
                    <KindIcon kind={s.kind} />
                    <span className="truncate">{s.qualifiedName}</span>
                  </div>
                  <div className="truncate pl-5 text-[11px] text-slate-500">{fileById.get(s.fileId)?.path}:{s.startLine}</div>
                </button>
              ))}
              {results.length >= 200 && <div className="p-2 text-center text-xs text-slate-500">仅显示前 200 条，请缩小搜索范围</div>}
            </>
          ) : (
            <div className="p-4 text-center text-sm text-slate-500">没有匹配项</div>
          )
        ) : (
          renderDir(dirTree, 0)
        )}
      </div>
    </div>
  );
}
