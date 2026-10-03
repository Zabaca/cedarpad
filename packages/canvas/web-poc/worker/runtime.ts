import { schema, type Database } from "../lib/db/index.js";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import type { Bindings } from "./context.js";

// One wrapper per isolate (module scope survives across requests), keyed off the D1
// binding identity: authenticate() and the route handlers share it instead of each
// wrapping the binding fresh per request.
let cached: { binding: unknown; db: Database } | null = null;

/** Build (or reuse) a Workers-compatible Drizzle db from the D1 binding (ADR-0018;
 * Turso rollback path retired in #268 — PLATFORM_DB is the only store now). */
export function createDbForWorker(env: Pick<Bindings, "PLATFORM_DB">): Database {
  if (cached?.binding === env.PLATFORM_DB) return cached.db;
  cached = { binding: env.PLATFORM_DB, db: drizzleD1(env.PLATFORM_DB, { schema }) };
  return cached.db;
}
