import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url).href);

export interface MigrationFile {
  name: string;
  statements: string[];
}

/**
 * The real migration files, in order, split the way `wrangler d1 migrations apply`
 * feeds them to D1 (one file at a time, on drizzle's statement breakpoint). A
 * migration D1 rejects therefore fails in the suite, not on deploy.
 *
 * Pure (node:fs / node:url only) so the in-memory libSQL query tests can share the
 * reader without pulling in Miniflare via `test-d1.ts`.
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

/**
 * Every migration statement, flattened in order — for the in-memory libSQL query tests
 * that apply them one at a time to a `:memory:` client. `test-d1.ts` reuses `migrationFiles()`
 * for the D1-parity path; this keeps the split-and-strip logic in one place.
 */
export function migrationStatements(): string[] {
  return migrationFiles().flatMap((f) => f.statements);
}
