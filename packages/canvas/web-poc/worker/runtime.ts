import { makeDb, schema, type Database } from "../lib/db/index.js";
import { createClient } from "@libsql/client/web";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import type { Bindings } from "./context.js";

/** Rewrite a `libsql://` URL to `https://` so `@libsql/client/web` speaks Hrana over HTTP
 * instead of opening a WebSocket. Per-request WSS clients (never closed) leaked sockets in
 * the worker isolate and serialized every request behind a fresh handshake — the cause of
 * the multi-second `/api/inbox` stalls and slow 401s. HTTP is stateless per query: nothing
 * to leak, nothing to hand-shake. */
export const tursoHttpUrl = (url: string): string => url.replace(/^libsql:/, "https:");

// One client per isolate (module scope survives across requests): authenticate() and the
// route handlers share it instead of each building their own per request.
let cached: { key: string; db: Database } | null = null;

/** Build (or reuse) a Workers-compatible Drizzle db from env bindings.
 *
 * D1 (ADR-0018) wins over Turso only when BOTH the `PLATFORM_DB` binding is present AND
 * `PLATFORM_DB_ENABLED` is "true". The flag exists because the binding's mere presence
 * used to be the switch: deploying a binding would then have been a cutover performed by
 * accident, silently repointing production at an empty database. With the flag off a bound
 * D1 is inert and Turso still serves — so the binding can ship ahead of the cutover (#265),
 * the cutover is one deliberate var flip (#267), and rollback is the same flip back. */
export function createDbForWorker(env: Bindings): Database {
  if (env.PLATFORM_DB && env.PLATFORM_DB_ENABLED === "true") return drizzleD1(env.PLATFORM_DB, { schema });
  const url = tursoHttpUrl(env.TURSO_URL);
  const key = `${url}\n${env.TURSO_KEY ?? ""}`;
  if (cached?.key === key) return cached.db;
  const client = createClient(env.TURSO_KEY ? { url, authToken: env.TURSO_KEY } : { url });
  cached = { key, db: makeDb(client) };
  return cached.db;
}
