import type { ReactNode } from "react";

/**
 * 极简且安全的 Markdown 渲染（标题、列表、代码块、行内代码、粗体）。
 * 不使用 dangerouslySetInnerHTML：模型输出中的任何 HTML 都会被当作纯文本显示。
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code key={`${keyBase}-${i++}`} className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[0.9em] text-amber-200">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <strong key={`${keyBase}-${i++}`} className="font-semibold text-slate-100">
          {tok.slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-md bg-slate-950 p-3 font-mono text-[0.9em] leading-[1.6] text-slate-200">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <h4 key={key++} className="mt-4 mb-1.5 text-[1.067em] font-semibold text-indigo-200">
          {inline(h[2], `h${key}`)}
        </h4>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key++} className={`my-1.5 space-y-1 pl-5 leading-[1.7] text-slate-300 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `li${key}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s+|```)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key++} className="my-1.5 leading-[1.7] text-slate-300">
        {inline(para.join(" "), `p${key}`)}
      </p>,
    );
  }
  return <div>{blocks}</div>;
}
