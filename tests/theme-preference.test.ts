import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_BOOTSTRAP_SCRIPT } from "../src/lib/theme-preference.ts";

function browser(saved: string | null = null, dark = false, blocked = false) {
  const dataset: Record<string, string> = {};
  const listeners = new Map<string, (event: unknown) => void>();
  let systemChange: () => void = () => {};
  const media = { matches: dark, addEventListener: (_name: string, callback: () => void) => { systemChange = callback; } };
  const storage = { value: saved };
  const context = {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem: () => { if (blocked) throw new Error("blocked"); return storage.value; },
      setItem: (_key: string, value: string) => { if (blocked) throw new Error("blocked"); storage.value = value; },
    },
    window: { matchMedia: () => media, addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback) },
  };
  runInNewContext(THEME_BOOTSTRAP_SCRIPT, context);
  return { dataset, storage,
    system: (next: boolean) => { media.matches = next; systemChange(); },
    choose: (detail: string) => listeners.get("atlas:theme-preference")?.({ detail }),
    remote: (newValue: string | null, key: string | null = "code-atlas:theme:v1") => listeners.get("storage")?.({ key, newValue }),
  };
}

test("new users follow the system before first paint and react to appearance changes", () => {
  const app = browser(null, true);
  assert.equal(app.dataset.themePreference, "system");
  assert.equal(app.dataset.theme, "dark");
  app.system(false); assert.equal(app.dataset.theme, "light");
  app.system(true); assert.equal(app.dataset.theme, "dark");
});

test("existing manual preferences survive upgrades and ignore system changes", () => {
  for (const preference of ["light", "dark"]) {
    const app = browser(preference, preference !== "dark");
    assert.equal(app.dataset.theme, preference);
    app.system(true); app.system(false);
    assert.equal(app.dataset.theme, preference);
    assert.equal(app.dataset.themePreference, preference);
  }
});

test("manual choice persists and returning to system immediately uses its current appearance", () => {
  const app = browser(null, true);
  app.choose("light"); app.system(false); app.system(true);
  assert.equal(app.dataset.theme, "light");
  assert.equal(app.storage.value, "light");
  app.choose("system");
  assert.equal(app.dataset.theme, "dark");
  assert.equal(app.storage.value, "system");
  assert.equal(browser(app.storage.value, false).dataset.theme, "light");
});

test("cross-tab updates and clearing preferences preserve each tab's resolved system appearance", () => {
  const app = browser("dark", false);
  app.remote("light", "unrelated"); assert.equal(app.dataset.theme, "dark");
  app.remote("light"); assert.equal(app.dataset.theme, "light");
  app.remote("system"); app.system(true); assert.equal(app.dataset.theme, "dark");
  app.remote(null, null); app.system(false);
  assert.equal(app.dataset.themePreference, "system");
  assert.equal(app.dataset.theme, "light");
});

test("invalid or unavailable storage falls back to system without disabling current-page overrides", () => {
  assert.equal(browser("invalid", true).dataset.theme, "dark");
  const app = browser(null, true, true);
  assert.equal(app.dataset.theme, "dark");
  app.choose("light"); app.system(true); assert.equal(app.dataset.theme, "light");
  app.choose("system"); app.system(false); assert.equal(app.dataset.theme, "light");
});
