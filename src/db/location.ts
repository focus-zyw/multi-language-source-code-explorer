import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Shared by the application and Drizzle Kit so both open the same local file. */
export function getDatabaseUrl(value = process.env.DATABASE_URL): string {
  const url = value ?? "file:./data/code-atlas.db";
  if (url === "file::memory:") return url;
  if (!url.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a local SQLite file URL, for example file:./data/code-atlas.db");
  }
  const filename = url.startsWith("file://") ? fileURLToPath(url) : resolve(url.slice(5));
  mkdirSync(dirname(filename), { recursive: true });
  return pathToFileURL(filename).href;
}
