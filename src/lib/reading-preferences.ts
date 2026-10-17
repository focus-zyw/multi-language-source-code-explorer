export type ReadingRegion = "code" | "explanation";
export const READING_DEFAULTS = { code: 14, explanation: 15 } as const;
export const READING_STORAGE_KEY = "code-atlas:reading:v1";
const HINT_KEY = "code-atlas:reading-hint:v1";
const MIN_SIZE = 10;
const MAX_SIZE = 28;
const INITIAL = { ...READING_DEFAULTS, notice: null as ReadingRegion | null, hint: false };
type Snapshot = { code: number; explanation: number; notice: ReadingRegion | null; hint: boolean };

const listeners = new Set<() => void>();
let snapshot: Snapshot = INITIAL;
let loaded = false;
let hintClaimed = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function readSize(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value))) : fallback;
}

function emit(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const stored = JSON.parse(localStorage.getItem(READING_STORAGE_KEY) ?? "null");
    snapshot = { ...snapshot, code: readSize(stored?.code, READING_DEFAULTS.code), explanation: readSize(stored?.explanation, READING_DEFAULTS.explanation) };
  } catch { /* Storage can be disabled; reading controls remain usable in memory. */ }
}

function persist() {
  try { localStorage.setItem(READING_STORAGE_KEY, JSON.stringify({ code: snapshot.code, explanation: snapshot.explanation })); } catch { /* Optional persistence. */ }
}

function syncStorage(event: StorageEvent) {
  if (event.key !== READING_STORAGE_KEY && event.key !== null) return;
  loaded = false;
  load();
  listeners.forEach((subscriber) => subscriber());
}

export const readingPreferences = {
  getSnapshot: () => { load(); return snapshot; },
  getServerSnapshot: () => INITIAL,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1) window.addEventListener("storage", syncStorage);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) window.removeEventListener("storage", syncStorage);
    };
  },
  pauseNotice: () => clearTimeout(noticeTimer),
  hideNoticeLater: () => {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => emit({ ...snapshot, notice: null }), 4000);
  },
  adjust: (region: ReadingRegion, direction: number) => {
    load();
    emit({ ...snapshot, [region]: readSize(snapshot[region] + direction, READING_DEFAULTS[region]), notice: region, hint: false });
    persist();
    readingPreferences.hideNoticeLater();
  },
  reset: (region: ReadingRegion) => {
    emit({ ...snapshot, [region]: READING_DEFAULTS[region], notice: region });
    persist();
    readingPreferences.hideNoticeLater();
  },
  showHintOnce: () => {
    if (hintClaimed) return false;
    hintClaimed = true;
    try {
      if (localStorage.getItem(HINT_KEY)) return false;
      localStorage.setItem(HINT_KEY, "1");
    } catch { /* Show once per session if storage is unavailable. */ }
    emit({ ...snapshot, hint: true });
    return true;
  },
  dismissHint: () => { if (snapshot.hint) emit({ ...snapshot, hint: false }); },
};
