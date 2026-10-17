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
  dismissed: boolean;
}

export const explanationTaskKey = (projectId: number, symbolId: number, backend: ExplanationBackend) => `${projectId}:${symbolId}:${backend}`;
const EMPTY: readonly ExplanationTask[] = [];

/** Browser-session tasks belong to the application, not to a mounted panel. */
export function createExplanationTasks(fetcher: typeof fetch = (...args) => fetch(...args)) {
  let snapshot: readonly ExplanationTask[] = EMPTY;
  const listeners = new Set<() => void>();
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
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
    publish({ ...task, loading: false, phase: "cancelled", error: null });
  };
  const start = (input: ExplanationTaskInput, onComplete?: (result: ExplanationResponse) => void): Promise<void> => {
    const key = explanationTaskKey(input.projectId, input.symbolId, input.backend);
    const existing = running.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const task: ExplanationTask = { ...input, key, loading: true, phase: "starting", startedAt: Date.now(), error: null, result: get(key)?.result, dismissed: false };
    // Register the request before fetch or rendering subscriptions can run.
    const promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const response = await fetcher(`/api/projects/${input.projectId}/symbols/${input.symbolId}/explain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: input.force, backend: input.backend, stream: input.backend === "agent" }),
          signal: controller.signal,
        });
        const result = await readExplanation(response, (event) => {
          if (!controller.signal.aborted) publish({ ...get(key)!, phase: event.phase, timeoutMs: event.timeoutMs });
        });
        if (controller.signal.aborted) return;
        publish({ ...get(key)!, loading: false, phase: "finishing", result, durationMs: result.durationMs ?? Date.now() - task.startedAt });
        onComplete?.(result);
      } catch (error) {
        if (!controller.signal.aborted) publish({ ...get(key)!, loading: false, error: error instanceof Error ? error.message : "生成失败" });
      } finally {
        if (running.get(key)?.controller === controller) running.delete(key);
      }
    });
    running.set(key, { controller, promise });
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
