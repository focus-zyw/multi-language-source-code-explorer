import type { AgentPhase, ExplanationBackend, ExplanationResponse } from "./ai-types.ts";
import { readExplanation } from "./read-explanation.ts";

export interface ExplanationTaskInput {
  projectId: number;
  symbolId: number;
  symbolName: string;
  backend: ExplanationBackend;
  force: boolean;
}

export interface ExplanationTask extends ExplanationTaskInput {
  key: string;
  loading: boolean;
  phase: AgentPhase | "cancelled";
  startedAt: number;
  timeoutMs?: number;
  durationMs?: number;
  error: string | null;
  result?: ExplanationResponse;
  /** 流式生成中的部分正文；结束后清空，避免与已保存结果不一致。 */
  partial?: string;
  dismissed: boolean;
}

export const explanationTaskKey = (projectId: number, symbolId: number, backend: ExplanationBackend) => `${projectId}:${symbolId}:${backend}`;
const EMPTY: readonly ExplanationTask[] = [];

/** 增量正文的合并间隔：每个 token 都推送会让界面按字重渲染。 */
const PARTIAL_PUSH_MS = 80;
const MAX_PARTIAL_CHARS = 64_000;

/** Browser-session tasks belong to the application, not to a mounted panel. */
export function createExplanationTasks(fetcher: typeof fetch = (...args) => fetch(...args)) {
  let snapshot: readonly ExplanationTask[] = EMPTY;
  const listeners = new Set<() => void>();
  const running = new Map<string, { controller: AbortController; promise: Promise<void>; discardPartial: () => void }>();
  const publish = (task: ExplanationTask) => {
    const others = snapshot.filter((item) => item.key !== task.key);
    // Bound completed history without ever evicting active requests.
    const active = others.filter((item) => item.loading);
    const completed = others.filter((item) => !item.loading).slice(-49);
    snapshot = [...completed, ...active, task];
    listeners.forEach((listener) => listener());
  };
  const get = (key: string) => snapshot.find((item) => item.key === key);
  const stop = (key: string) => {
    const active = running.get(key);
    const task = get(key);
    if (!active || !task) return;
    running.delete(key);
    active.controller.abort();
    active.discardPartial();
    publish({ ...task, loading: false, phase: "cancelled", error: null, partial: undefined });
  };
  const start = (input: ExplanationTaskInput, onComplete?: (result: ExplanationResponse) => void): Promise<void> => {
    const key = explanationTaskKey(input.projectId, input.symbolId, input.backend);
    const existing = running.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const task: ExplanationTask = { ...input, key, loading: true, phase: "starting", startedAt: Date.now(), error: null, result: get(key)?.result, dismissed: false };
    let partial = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPush = 0;
    const pushPartial = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      lastPush = Date.now();
      const current = get(key);
      if (current?.loading) publish({ ...current, partial });
    };
    const appendPartial = (text: string) => {
      if (partial.length >= MAX_PARTIAL_CHARS) return;
      partial += text.slice(0, MAX_PARTIAL_CHARS - partial.length);
      const elapsed = Date.now() - lastPush;
      if (elapsed >= PARTIAL_PUSH_MS) pushPartial();
      else if (!flushTimer) flushTimer = setTimeout(pushPartial, PARTIAL_PUSH_MS - elapsed);
    };
    const discardPartial = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
      partial = "";
    };
    // Register the request before fetch or rendering subscriptions can run.
    const promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const response = await fetcher(`/api/projects/${input.projectId}/symbols/${input.symbolId}/explain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: input.force, backend: input.backend, stream: true }),
          signal: controller.signal,
        });
        const result = await readExplanation(response, (event) => {
          if (!controller.signal.aborted) publish({ ...get(key)!, phase: event.phase, timeoutMs: event.timeoutMs });
        }, (text) => {
          if (!controller.signal.aborted) appendPartial(text);
        });
        if (controller.signal.aborted) return;
        discardPartial();
        publish({ ...get(key)!, loading: false, phase: "finishing", partial: undefined, result, durationMs: result.durationMs ?? Date.now() - task.startedAt });
        onComplete?.(result);
      } catch (error) {
        discardPartial();
        if (!controller.signal.aborted) publish({ ...get(key)!, loading: false, partial: undefined, error: error instanceof Error ? error.message : "生成失败" });
      } finally {
        discardPartial();
        if (running.get(key)?.controller === controller) running.delete(key);
      }
    });
    running.set(key, { controller, promise, discardPartial });
    publish(task);
    return promise;
  };
  return {
    start, stop, get,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      // Removing a view subscription must never cancel generation.
      return () => { listeners.delete(listener); };
    },
    dismiss: (key: string) => {
      const task = get(key);
      if (task && !task.loading) publish({ ...task, dismissed: true });
    },
  };
}

export const explanationTasks = createExplanationTasks();
