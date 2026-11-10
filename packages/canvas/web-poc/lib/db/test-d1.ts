import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import type { Database } from "./client.js";
import * as schema from "./schema.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url).href);

export interface MigrationFile {
  name: string;
  statements: string[];
}

/**
 * The real migration files, in order, split the way `wrangler d1 migrations apply`
 * feeds them to D1 (one file at a time, on drizzle's statement breakpoint). A
 * migration D1 rejects therefore fails in the suite, not on deploy.
 */
export function migrationFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      name: f,
      statements: readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) =>
          s
            .split("\n")
            .filter((l) => !l.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean),
    }));
}

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
