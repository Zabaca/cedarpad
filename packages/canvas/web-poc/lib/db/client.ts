import type { Client } from "@libsql/client";
import { createClient, type Config as LibsqlConfig } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof makeDb>;

export interface DbConfig {
  url: string;
  authToken?: string;
}

/** Wrap an existing libSQL client (node OR web) in Drizzle with our schema. */
export function makeDb(client: Client) {
  return drizzle(client, { schema });
}

/**
 * Node/Bun-side factory (CLI, tests, migrations). On Cloudflare Workers, build
 * a client with `@libsql/client/web` and pass it to {@link makeDb} instead.
 */
export function createDb(config: DbConfig): Database {
  const clientConfig: LibsqlConfig = { url: config.url };
  if (config.authToken) clientConfig.authToken = config.authToken;
  return makeDb(createClient(clientConfig));
}
