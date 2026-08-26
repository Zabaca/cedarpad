import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import type { Database } from "./client.js";
import * as schema from "./schema.js";
import { type MigrationFile, migrationFiles } from "./test-migrations.js";

export { type MigrationFile, migrationFiles } from "./test-migrations.js";

export async function applyMigrations(d1: D1Database, files = migrationFiles()) {
  for (const file of files) {
    for (const stmt of file.statements) await d1.prepare(stmt).run();
  }
}

export interface TestD1 {
  /** The Drizzle handle to hand to `buildApp({ db })` — the D1 driver, as in production. */
  db: Database;
  /** The raw binding, for asserting what the engine itself does and does not accept. */
  d1: D1Database;
  dispose: () => Promise<void>;
}

/**
 * A real D1 for tests: workerd's own D1 (via Miniflare), migrated with the real
 * migration files. The point is engine parity — libSQL-only functions such as
 * `vector32()` / `vector_distance_cos()` fail here exactly as they do in production
 * (ADR-0018: the platform data layer is D1). Each call gets its own empty database.
 *
 * Pass `migrations` to apply a subset (a test that exercises one migration's effect
 * on rows written under the previous schema).
 */
export async function createTestD1(options: { migrations?: MigrationFile[] } = {}): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch: () => new Response('ok') };",
    d1Databases: { PLATFORM_DB: "test-platform" },
  });
  const d1 = await mf.getD1Database("PLATFORM_DB");
  await applyMigrations(d1, options.migrations ?? migrationFiles());

  return {
    db: drizzleD1(d1, { schema }) as unknown as Database,
    d1,
    dispose: () => mf.dispose(),
  };
}
