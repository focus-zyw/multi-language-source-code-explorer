"use client";

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import { sliceLines, type CodeViewerProps, type ViewerRef } from "./viewer-types";

// 只读源码浏览只需要基础的编辑器 worker；不加载 TS/JSON 等语言服务（无需执行或类型检查项目代码）
if (typeof window !== "undefined") {
  const w = window as unknown as { MonacoEnvironment?: unknown };
  if (!w.MonacoEnvironment) {
    w.MonacoEnvironment = {
      getWorker() {
        return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
      },
    };
  }
}

const LABEL: Record<string, string> = {
  exact: "确定",
  inferred: "推断",
  heuristic: "候选·猜测",
  external: "外部/内建",
  unresolved: "无法解析",
};

export default function MonacoEditor({ content, language, fileKey, range, mode, refs, highlight, onRefClick, fontSize = 14 }: CodeViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const offsetRef = useRef(0);
  const refsRef = useRef<ViewerRef[]>([]);
  const clickRef = useRef(onRefClick);
  useEffect(() => { clickRef.current = onRefClick; }, [onRefClick]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value: "",
      language: "plaintext",
      readOnly: true,
      domReadOnly: true,
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 14,
      lineHeight: 22,
      mouseWheelZoom: false,
      renderLineHighlight: "none",
      contextmenu: false,
      occurrencesHighlight: "off",
      selectionHighlight: false,
      stickyScroll: { enabled: false },
      glyphMargin: false,
      folding: true,
      smoothScrolling: true,
      padding: { top: 8, bottom: 8 },
      lineNumbers: (n: number) => String(n + offsetRef.current),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    });
    editorRef.current = editor;
    decoRef.current = editor.createDecorationsCollection([]);
    const sub = editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position || !e.event.leftButton) return;
      const line = e.target.position.lineNumber + offsetRef.current;
      const col = e.target.position.column;
      const hit = refsRef.current.find((r) => r.line === line && r.endLine === line && col >= r.col && col <= r.endCol);
      if (hit) clickRef.current(hit.id);
    });
    return () => {
      sub.dispose();
      decoRef.current?.clear();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.6) });
  }, [fontSize]);

  // 内容 / 模式切换
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const offset = mode === "method" ? range.startLine - 1 : 0;
    offsetRef.current = offset;
    const text = mode === "method" ? sliceLines(content, range.startLine, range.endLine) : content;
    const modelLanguage = language === "vue" ? mode === "method" && range.startLine > 1 ? "typescript" : "html" : language;
    let model = ed.getModel();
    if (!model) {
      model = monaco.editor.createModel(text, modelLanguage);
      ed.setModel(model);
    } else {
      if (model.getValue() !== text) model.setValue(text);
      monaco.editor.setModelLanguage(model, modelLanguage);
    }
    ed.updateOptions({ lineNumbers: (n: number) => String(n + offset) });
    ed.setScrollTop(0);
    if (mode === "file") ed.revealLineNearTop(Math.max(1, range.startLine));
  }, [content, language, mode, range.startLine, range.endLine, fileKey]);

  // 装饰：当前符号范围、调用引用、高亮
  useEffect(() => {
    const ed = editorRef.current;
    const deco = decoRef.current;
    if (!ed || !deco) return;
    const offset = mode === "method" ? range.startLine - 1 : 0;
    const model = ed.getModel();
    const maxLine = model ? model.getLineCount() : 1;
    const clamp = (l: number) => Math.min(Math.max(l - offset, 1), maxLine);
    refsRef.current = refs;
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    if (mode === "file") {
      decos.push({
        range: new monaco.Range(clamp(range.startLine), 1, clamp(range.endLine), 1),
        options: { isWholeLine: true, className: "sym-bg" },
      });
    }
    for (const r of refs) {
      decos.push({
        range: new monaco.Range(clamp(r.line), r.col, clamp(r.endLine), r.endCol),
        options: {
          inlineClassName: `ref ref-${r.resolution}`,
          hoverMessage: { value: `**${LABEL[r.resolution]}** · ${r.label}` },
        },
      });
    }
    if (highlight) {
      decos.push({
        range: new monaco.Range(clamp(highlight.startLine), 1, clamp(highlight.endLine), 1),
        options: { isWholeLine: true, className: "flow-hl" },
      });
    }
    deco.set(decos);
    if (highlight) ed.revealLinesInCenterIfOutsideViewport(clamp(highlight.startLine), clamp(highlight.endLine));
  }, [refs, highlight, mode, range.startLine, range.endLine, content, fileKey]);

  return <div ref={hostRef} className="h-full w-full" />;
}
