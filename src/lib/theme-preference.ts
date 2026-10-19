export type ThemePreference = "system" | "light" | "dark";

// Self-contained: the same function runs before first paint and in runtime tests.
function initializeTheme() {
  const root = document.documentElement;
  const key = "code-atlas:theme:v1";
  const normalize = (value: unknown) => value === "light" || value === "dark" ? value : "system";
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  let preference = "system";
  try { preference = normalize(localStorage.getItem(key)); } catch { /* Use system appearance without storage. */ }
  const apply = () => {
    root.dataset.themePreference = preference;
    root.dataset.theme = preference === "system" ? media?.matches ? "dark" : "light" : preference;
  };
  apply();
  media?.addEventListener("change", () => { if (preference === "system") apply(); });
  window.addEventListener("atlas:theme-preference", (event) => {
    preference = normalize((event as CustomEvent<unknown>).detail);
    apply();
    try { localStorage.setItem(key, preference); } catch { /* Current-page switching remains available. */ }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
}

export const THEME_BOOTSTRAP_SCRIPT = `(${initializeTheme.toString()})();`;
