"use client";

import dynamic from "next/dynamic";
import { Component, useState, type ReactNode } from "react";
import PlainCode from "./PlainCode";
import type { CodeViewerProps } from "./viewer-types";

const MonacoEditor = dynamic(() => import("./MonacoEditor"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-slate-500">正在加载编辑器…</div>,
});

class Boundary extends Component<{ fallback: ReactNode; onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("Monaco 编辑器加载失败，已回退到简易只读查看器：", error);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Monaco（只读）为主；若其脚本/worker 加载失败则自动回退到简易查看器 */
export function CodeViewer(props: CodeViewerProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PlainCode {...props} />;
  return (
    <Boundary fallback={<PlainCode {...props} />} onFail={() => setFailed(true)}>
      <MonacoEditor {...props} />
    </Boundary>
  );
}
