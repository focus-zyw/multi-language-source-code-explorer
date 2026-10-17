import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getDatabaseUrl } from "./location";

const databaseUrl = getDatabaseUrl();
const globalForDb = globalThis as typeof globalThis & {
  __codeAtlasSqlite?: { url: string; client: Client };
};

const cached = globalForDb.__codeAtlasSqlite;
export const client = cached?.url === databaseUrl && !cached.client.closed
  ? cached.client
  : createClient({ url: databaseUrl });

if (process.env.NODE_ENV !== "production") {
  if (cached && cached.client !== client) cached.client.close();
  globalForDb.__codeAtlasSqlite = { url: databaseUrl, client };
}

export const db = drizzle(client);
