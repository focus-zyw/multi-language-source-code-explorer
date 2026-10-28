import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Children, isValidElement, type ReactNode } from "react";
import { normalizeFileNoteMath, remarkFileNoteCitations } from "@/lib/file-note-rendering";
import FileNoteCodeBlock from "./FileNoteCodeBlock";
import FileNoteMedia from "./FileNoteMedia";
import "katex/dist/katex.min.css";

/** Raw HTML stays inert; mathematical notation is normalized only for preview. */
export default function FileNoteMarkdown({ text }: { text: string }) {
  return <div className="file-note-markdown min-w-0 break-words text-sm leading-7 text-slate-300 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkFileNoteCitations]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000 }]]}
      components={{
        p: ({ children }) => <div className="my-2 whitespace-pre-wrap">{children}</div>,
        h1: ({ children }) => <h2 className="mb-3 mt-5 text-xl font-semibold text-slate-100">{children}</h2>,
        h2: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold text-slate-100">{children}</h3>,
        h3: ({ children }) => <h4 className="mb-2 mt-3 font-semibold text-slate-100">{children}</h4>,
        ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
        ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal pl-6">{children}</ol>,
        pre: ({ children }) => {
          const child = Children.toArray(children).find((item) => isValidElement<{ children?: ReactNode; className?: string }>(item));
          if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>;
          return <FileNoteCodeBlock code={String(child.props.children ?? "").replace(/\n$/, "")} language={/language-([^\s]+)/.exec(child.props.className ?? "")?.[1]} />;
        },
        code: ({ children, className }) => <code className={className ?? "rounded bg-slate-800 px-1 py-0.5 font-mono text-[0.9em]"}>{children}</code>,
        blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-slate-600 pl-3 text-slate-400">{children}</blockquote>,
        table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-left">{children}</table></div>,
        th: ({ children }) => <th className="border border-slate-700 px-3 py-1 font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-slate-700 px-3 py-1">{children}</td>,
        a: ({ children, href, node }) => {
          const icon = node?.properties["data-citation-icon"];
          const count = node?.properties["data-citation-count"];
          return typeof icon === "string" ? <a href={href} target="_blank" rel="noreferrer noopener" className="my-1 inline-flex max-w-full items-center gap-2 rounded-full border border-slate-700 bg-slate-800/50 px-3 py-1 text-xs text-slate-300 no-underline">
            {/* eslint-disable-next-line @next/next/no-img-element -- remote clipboard favicon; no optimization proxy */}
            <img src={icon} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer" className="h-4 w-4 shrink-0 rounded-sm" />
            <span className="truncate">{children}</span>{typeof count === "string" && count && <span className="shrink-0 text-slate-500" title="原文未提供其余来源链接">{count}</span>}
          </a> : <a href={href} target="_blank" rel="noreferrer noopener" className="text-indigo-300 underline">{children}</a>;
        },
        img: ({ alt, src, title }) => <FileNoteMedia key={typeof src === "string" ? src : undefined} src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
      }}>{normalizeFileNoteMath(text)}</ReactMarkdown>
  </div>;
}
