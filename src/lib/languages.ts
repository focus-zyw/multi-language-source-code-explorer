/** Client-safe labels; parser plugins stay server-side. */
export const LANGUAGE_LABELS: Record<string, string> = { python: "Python", javascript: "JavaScript", typescript: "TypeScript", go: "Go", java: "Java", vue: "Vue" };
export const LANGUAGE_SHORT_LABELS: Record<string, string> = { ...LANGUAGE_LABELS, javascript: "JS", typescript: "TS" };
