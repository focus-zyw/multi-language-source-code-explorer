import * as nextEnv from "@next/env";
import { defineConfig } from "drizzle-kit";
import { getDatabaseUrl } from "./src/db/location.ts";

// Use the same environment file precedence as the Next.js application.
const envLoader = (nextEnv as unknown as { default?: typeof nextEnv }).default ?? nextEnv;
envLoader.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  dbCredentials: { url: getDatabaseUrl() },
});
