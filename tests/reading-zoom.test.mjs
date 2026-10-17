import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the installed native wheel listener and persistence together, without
// a real model or changing the user's browser preferences.
function setup(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const host = new EventTarget();
  const effects = [];
  let time = 1000;
  let wheelOptions;
  const addListener = host.addEventListener.bind(host);
  host.addEventListener = (name, listener, options) => { wheelOptions = options; addListener(name, listener, options); };
  const require = createRequire(import.meta.url);
  const context = {
    console, setTimeout, clearTimeout, window: new EventTarget(), performance: { now: () => time },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  function load(path, dependencies = {}) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const target = { exports: {} };
    runInNewContext(compiled, { ...context, module: target, exports: target.exports, require: (name) => dependencies[name] ?? require(name) });
    return target.exports;
  }
  const { readingPreferences: preferences, READING_STORAGE_KEY: key } = load("../src/lib/reading-preferences.ts");
  const { ReadingZoom } = load("../src/components/ReadingZoom.tsx", {
    "@/lib/reading-preferences": { readingPreferences: preferences },
    react: { useRef: () => ({ current: host }), useSyncExternalStore: (_subscribe, get) => get(), useEffect: (effect) => effects.push(effect) },
  });
  let cleanup;
  function mount(region) {
    cleanup?.();
    ReadingZoom({ region, children: (size) => String(size) });
    cleanup = effects.pop()();
  }
  function wheel(deltaY, ctrlKey = false, deltaMode = 0, elapsed = 100) {
    time += elapsed;
    const event = new Event("wheel", { cancelable: true });
    Object.defineProperties(event, { deltaY: { value: deltaY }, ctrlKey: { value: ctrlKey }, deltaMode: { value: deltaMode } });
    host.dispatchEvent(event);
    return event;
  }
  return { preferences, storage, key, mount, wheel, options: () => wheelOptions, dispose: () => { cleanup?.(); preferences.pauseNotice(); } };
}

test("ordinary wheel stays native; Ctrl-wheel changes only its reading region and reset is independent", () => {
  const h = setup();
  try {
    h.mount("code");
    assert.equal(h.options().capture, true);
    assert.equal(h.options().passive, false);
    assert.equal(h.wheel(120).defaultPrevented, false);
    assert.equal(h.preferences.getSnapshot().code, 14);
    assert.equal(h.wheel(-120, true).defaultPrevented, true);
    assert.equal(h.preferences.getSnapshot().code, 15);
    assert.equal(h.preferences.getSnapshot().explanation, 15);
    h.mount("explanation");
    h.wheel(-120, true);
    assert.equal(h.preferences.getSnapshot().explanation, 16);
    h.preferences.reset("explanation");
    assert.equal(h.preferences.getSnapshot().explanation, 15);
    assert.equal(h.preferences.getSnapshot().code, 15);
    assert.deepEqual(JSON.parse(h.storage.get(h.key)), { code: 15, explanation: 15 });
  } finally { h.dispose(); }
});

test("wheel limits keep browser zoom suppressed, and rapid trackpad events do not jump font sizes", () => {
  const h = setup();
  try {
    h.mount("code");
    for (let i = 0; i < 30; i++) h.wheel(-120, true);
    assert.equal(h.preferences.getSnapshot().code, 28);
    assert.equal(h.wheel(-120, true).defaultPrevented, true);
    for (let i = 0; i < 40; i++) h.wheel(120, true);
    assert.equal(h.preferences.getSnapshot().code, 10);
    h.preferences.reset("code");
    h.wheel(-120, true);
    h.wheel(-120, true, 0, 1);
    assert.equal(h.preferences.getSnapshot().code, 15);
    assert.equal(h.wheel(0, true).defaultPrevented, false);
  } finally { h.dispose(); }
});

test("saved settings survive a new session; corrupt storage falls back to readable defaults", () => {
  for (const value of ['{"code":20,"explanation":18}', 'broken-json']) {
    const h = setup({ "code-atlas:reading:v1": value });
    try {
      h.mount("code");
      assert.equal(h.preferences.getSnapshot().code, value === 'broken-json' ? 14 : 20);
      assert.equal(h.preferences.getSnapshot().explanation, value === 'broken-json' ? 15 : 18);
      assert.equal(h.preferences.showHintOnce(), true);
      h.preferences.dismissHint();
      assert.equal(h.preferences.showHintOnce(), false);
    } finally { h.dispose(); }
  }
});
