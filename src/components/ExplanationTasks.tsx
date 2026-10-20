"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { explanationTasks } from "@/lib/explanation-tasks";
import { retryStatus } from "@/lib/retry-status";

/** Root-layout controls remain available when the explanation panel unmounts. */
export function ExplanationTasks() {
  const tasks = useSyncExternalStore(explanationTasks.subscribe, explanationTasks.getSnapshot, explanationTasks.getServerSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const visible = tasks.filter((task) => !task.dismissed);
  if (!visible.length) return null;
  const active = visible.filter((task) => task.loading).length;
  return (
    <aside aria-label="AI 讲解任务" className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-indigo-500/40 bg-slate-950 shadow-xl">
      <button onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} className="flex w-full items-center justify-between rounded-t-xl px-3 py-2 text-left text-xs text-indigo-200 hover:bg-slate-900">
        <span>AI 讲解 · {active ? `${active} 项正在生成` : "任务已结束"}</span>
        <span>{collapsed ? "展开" : "收起"}</span>
      </button>
      {!collapsed && <div className="max-h-[35vh] overflow-y-auto border-t border-slate-800">
        {visible.map((task) => <div key={task.key} className="flex items-center gap-2 border-b border-slate-800/60 px-3 py-2 last:border-0">
          <div className="min-w-0 flex-1">
            <Link href={`/p/${task.projectId}?s=${task.symbolId}&ai=${task.backend}`} title={`定位方法：${task.symbolName}`} className="block truncate text-xs text-slate-200 hover:text-indigo-300">{task.symbolName}</Link>
            <p className={`mt-1 text-[11px] ${task.error ? "text-rose-300" : "text-slate-400"}`} role="status">
              {task.backend === "agent" ? "Agent" : "模型 API"} · {task.loading ? task.retry ? retryStatus(task.retry) : "后台生成中，可继续浏览" : task.error ? "生成失败，返回方法查看" : task.phase === "cancelled" ? "已停止" : "讲解已保存"}
            </p>
          </div>
          <button onClick={() => task.loading ? explanationTasks.stop(task.key) : explanationTasks.dismiss(task.key)} aria-label={`${task.loading ? "停止分析" : "关闭通知"}：${task.symbolName}`} className="shrink-0 rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">{task.loading ? "停止" : "关闭"}</button>
        </div>)}
      </div>}
    </aside>
  );
}
