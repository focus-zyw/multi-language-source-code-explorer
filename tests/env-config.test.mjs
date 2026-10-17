import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const configUrl = new URL("../drizzle.config.ts", import.meta.url).href;

function runConfig(files, databaseUrl) {
  const cwd = mkdtempSync(join(tmpdir(), "code-atlas-env-"));
  const env = { ...process.env, NODE_ENV: "development" };
  delete env.DATABASE_URL;
  delete env.__NEXT_PROCESSED_ENV;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(cwd, name), content);
    }
    return spawnSync(process.execPath, [
      "--experimental-strip-types", "--input-type=module", "-e",
      `import config from ${JSON.stringify(configUrl)}; process.stdout.write(JSON.stringify(config.dbCredentials));`,
    ], { cwd, env, encoding: "utf8" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("Drizzle reads .env.local with the same precedence as Next development", () => {
  const result = runConfig({
    ".env": "DATABASE_URL=file:./base.db",
    ".env.development": "DATABASE_URL=file:./development.db",
    ".env.local": "DATABASE_URL=file:./local.db",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fileURLToPath(JSON.parse(result.stdout).url), /[/\\]local\.db$/);
});

test("an explicit environment variable takes precedence over files", () => {
  const result = runConfig({ ".env.local": "DATABASE_URL=file:./local.db" }, "file:./explicit.db");
  assert.equal(result.status, 0, result.stderr);
  assert.match(fileURLToPath(JSON.parse(result.stdout).url), /[/\\]explicit\.db$/);
});

test("no environment setup is required to use the default local database", () => {
  const result = runConfig({ ".env.example": "DATABASE_URL=file:./ignored.db" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fileURLToPath(JSON.parse(result.stdout).url), /[/\\]data[/\\]code-atlas\.db$/);
});

test("a stale PostgreSQL URL fails with SQLite setup instructions", () => {
  const result = runConfig({}, "postgresql://example/db");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL must be a local SQLite file URL/);
});
