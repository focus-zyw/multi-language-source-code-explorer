"use client";

import { useMemo, useState, type ReactNode } from "react";
import { createLowlight } from "lowlight";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import java from "highlight.js/lib/languages/java";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import type { RootContent } from "hast";
import { codeLanguage, recoverPythonLines } from "@/lib/file-note-rendering";

const highlighter = createLowlight({ python, javascript, typescript, json, java, csharp, go, bash, css, xml, sql });
const labels: Record<string, string> = { python: "Python", py: "Python", javascript: "JavaScript", js: "JavaScript", typescript: "TypeScript", ts: "TypeScript", json: "JSON", java: "Java", csharp: "C#", cs: "C#", go: "Go", bash: "Shell", sh: "Shell", css: "CSS", xml: "HTML / XML", html: "HTML", sql: "SQL", text: "文本" };
function tokens(nodes: RootContent[], prefix = ""): ReactNode[] {
  return nodes.map((node, index) => node.type === "text" ? node.value : node.type === "element"
    ? <span key={`${prefix}${index}`} className={Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined}>{tokens(node.children, `${prefix}${index}-`)}</span> : null);
}

export default function FileNoteCodeBlock({ code, language = "" }: { code: string; language?: string }) {
  const resolved = codeLanguage(code, language);
  const [recovered, setRecovered] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const suggestion = useMemo(() => ["python", "py"].includes(resolved) ? recoverPythonLines(code) : code, [code, resolved]);
  const shown = recovered ? suggestion : code;
  const highlighted = useMemo(() => {
    if (!highlighter.registered(resolved)) return shown;
    try { return tokens(highlighter.highlight(resolved, shown).children); } catch { return shown; }
  }, [shown, resolved]);
  return <div className="file-note-code my-4 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/60">
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-slate-800/60 px-4 py-2 text-xs text-slate-400">
      <span className="mr-auto font-medium">{labels[resolved] ?? resolved}</span>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)} className="hover:text-slate-100">自动换行</button>
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(shown); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }} className="hover:text-slate-100">{copied ? "已复制" : "复制代码"}</button>
    </div>
    {suggestion !== code && <div className="flex flex-wrap items-center gap-2 border-b border-slate-700 px-4 py-2 text-xs text-amber-300">
      <span className="flex-1">{recovered ? "当前为推测恢复，缩进请核对；笔记原文未改动。" : "这段代码可能在粘贴前丢失了换行。"}</span>
      <button type="button" onClick={() => { setRecovered(!recovered); setCopied(false); }} className="shrink-0 underline">{recovered ? "查看原文" : "尝试恢复换行"}</button>
    </div>}
    <pre className={`m-0 max-h-[40rem] overflow-auto p-4 font-mono text-[13px] leading-6 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}><code>{highlighted}</code></pre>
    {copyError && <p role="status" className="px-4 pb-2 text-xs text-amber-300">复制失败，请选中代码手动复制。</p>}
  </div>;
}
