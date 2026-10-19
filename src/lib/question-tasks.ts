import { readExplanation } from "./read-explanation.ts";
import type { QuestionHistory, QuestionInput } from "./question-types.ts";

export interface QuestionTask {
  key: string; projectId: number; symbolId: number; backend: "api" | "agent";
  loading: boolean; refreshing: boolean; error: string | null; phase: string; history: QuestionHistory | null; pending?: QuestionInput;
}
const EMPTY: readonly QuestionTask[] = [];
export const questionTaskKey = (project: number, symbol: number, backend: string) => `${project}:${symbol}:${backend}`;

/** Session-owned requests survive panel/method changes; only explicit stop aborts. */
export function createQuestionTasks(fetcher: typeof fetch = (...args) => fetch(...args)) {
  let snapshot: readonly QuestionTask[] = EMPTY;
  const listeners = new Set<() => void>();
  const active = new Map<string, AbortController>();
  const loads = new Map<string, number>();
  const get = (key: string) => snapshot.find((task) => task.key === key);
  const publish = (task: QuestionTask) => {
    const others = snapshot.filter((item) => item.key !== task.key);
    snapshot = [...others.filter((item) => !item.loading && !item.refreshing).slice(-49), ...others.filter((item) => item.loading || item.refreshing), task];
    listeners.forEach((listener) => listener());
  };
  const url = (task: QuestionTask) => `/api/projects/${task.projectId}/symbols/${task.symbolId}/questions`;
  const load = async (projectId: number, symbolId: number, backend: "api" | "agent") => {
    const key = questionTaskKey(projectId, symbolId, backend);
    const task = get(key) ?? { key, projectId, symbolId, backend, loading: false, refreshing: false, error: null, phase: "", history: null };
    const version = (loads.get(key) ?? 0) + 1; loads.set(key, version);
    publish({ ...task, refreshing: true });
    try {
      const response = await fetcher(`${url(task)}?backend=${backend}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "无法读取问答记录");
      if (loads.get(key) === version) publish({ ...get(key)!, refreshing: false, history: body });
    } catch (error) {
      if (loads.get(key) === version) publish({ ...get(key)!, refreshing: false, error: error instanceof Error ? error.message : "无法读取问答记录" });
    }
  };
  const start = async (projectId: number, symbolId: number, input: QuestionInput) => {
    const key = questionTaskKey(projectId, symbolId, input.backend), task = get(key);
    if (!task || active.has(key)) return;
    const controller = new AbortController(); active.set(key, controller);
    publish({ ...task, loading: true, error: null, phase: "正在启动", pending: input });
    try {
      const response = await fetcher(url(task), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: controller.signal });
      await readExplanation(response, (event) => { if (!controller.signal.aborted) publish({ ...get(key)!, phase: event.phase === "starting" ? "正在启动" : event.phase === "finishing" ? "正在保存" : "正在回答" }); });
      if (!controller.signal.aborted) publish({ ...get(key)!, loading: false, phase: "已保存", pending: undefined });
    } catch (error) {
      publish({ ...get(key)!, loading: false, phase: controller.signal.aborted ? "已停止" : "回答失败", error: controller.signal.aborted ? null : error instanceof Error ? error.message : "回答失败", pending: undefined });
    } finally {
      if (active.get(key) === controller) active.delete(key);
      await load(projectId, symbolId, input.backend);
    }
  };
  return { load, start, get, stop: (key: string) => active.get(key)?.abort(), getSnapshot: () => snapshot, getServerSnapshot: () => EMPTY,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export const questionTasks = createQuestionTasks();
