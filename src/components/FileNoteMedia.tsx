"use client";

import { createElement, useEffect, useState, type ReactNode } from "react";
import { decodeNoteLayout, encodeNoteLayout, type RichNoteNode } from "@/lib/file-note-rich";

export function renderNoteLayout(nodes: RichNoteNode[], prefix = ""): ReactNode[] {
  return nodes.map((node, index) => {
    if (typeof node === "string") return node;
    const props = { ...node.attrs, style: node.style, key: `${prefix}${index}` };
    if (node.tag === "a") Object.assign(props, { target: "_blank", rel: "noreferrer noopener" });
    if (node.tag === "img") Object.assign(props, { loading: "lazy", referrerPolicy: "no-referrer" });
    return createElement(node.tag, props, ["img", "br", "hr"].includes(node.tag) ? undefined : renderNoteLayout(node.children, `${prefix}${index}-`));
  });
}
export default function FileNoteMedia({ src, alt = "笔记图片", title }: { src?: string; alt?: string; title?: string }) {
  const layout = /^\/api\/projects\/\d+\/note-media\/[a-f0-9-]{36}\?layout=1$/.test(src ?? "");
  const [nodes, setNodes] = useState<RichNoteNode[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!layout || !src) return;
    const ac = new AbortController();
    fetch(src, { signal: ac.signal }).then(async (response) => {
      if (!response.ok) throw new Error("layout unavailable");
      const result = await response.json();
      const valid = decodeNoteLayout(encodeNoteLayout(result.nodes));
      if (!valid) throw new Error("invalid layout");
      if (!ac.signal.aborted) setNodes(valid);
    }).catch(() => { if (!ac.signal.aborted) setFailed(true); });
    return () => ac.abort();
  }, [src, layout]);
  if (layout) return <span className="file-note-rich my-3 block max-w-full overflow-auto" role="group" aria-label={alt}>{nodes ? renderNoteLayout(nodes) : failed ? "布局附件读取失败" : "正在加载布局…"}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- local note attachment or explicit remote Markdown image
  return <img src={src} alt={alt} title={title} loading="lazy" referrerPolicy="no-referrer" className="my-3 inline-block h-auto max-h-[48rem] max-w-full rounded-lg object-contain" />;
}
