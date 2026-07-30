// Shared in-memory test database built from the REAL Drizzle migrations.
//
// Every `lib/db/**` query test needs the same thing: a `:memory:` libSQL client
// with the production migrations applied, and a Drizzle db bound to the platform
// schema. That setup was copy-pasted verbatim across a dozen `*.test.ts` files —
// and had already started to drift (two whitespace variants of the same parser).
// This is the single home for it, so a migration-format or client change is one
// edit, not twelve. Not a `*.test.ts` file, so vitest never collects it directly.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** Every migration's statements, in order — mirrors what the real migrator applies. */
export function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean),
    );
}

/** A fresh in-memory libSQL client + Drizzle db bound to the platform schema. */
export function createTestDb() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  return { client, db };
}

/** Apply every real migration, in order, to a test client. */
export async function applyMigrations(client: Client): Promise<void> {
  for (const stmt of migrationStatements()) await client.execute(stmt);
}
