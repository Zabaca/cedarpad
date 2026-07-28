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
 * A bound `PLATFORM_DB` (D1) wins over Turso — that is how local dev runs the platform
 * data layer on miniflare's D1 (ADR-0018, #263). Production has no such binding yet, so
 * it keeps taking the Turso path below. */
export function createDbForWorker(env: Bindings): Database {
  if (env.PLATFORM_DB) return drizzleD1(env.PLATFORM_DB, { schema });
  const url = tursoHttpUrl(env.TURSO_URL);
  const key = `${url}\n${env.TURSO_KEY ?? ""}`;
  if (cached?.key === key) return cached.db;
  const client = createClient(env.TURSO_KEY ? { url, authToken: env.TURSO_KEY } : { url });
  cached = { key, db: makeDb(client) };
  return cached.db;
}
