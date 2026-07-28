import type { Client } from "@libsql/client";
import { createClient, type Config as LibsqlConfig } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";

/**
 * The platform data layer's database handle, deliberately widened to the
 * driver-agnostic Drizzle SQLite base (ADR-0018): async, schema-bound, and
 * indifferent to the driver's run-result shape, so both the libSQL and the D1
 * drivers satisfy it. Consumers must stay on this surface — see
 * `client.test-d.ts`, which asserts both drivers still fit.
 */
export type Database = BaseSQLiteDatabase<"async", unknown, typeof schema>;

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
