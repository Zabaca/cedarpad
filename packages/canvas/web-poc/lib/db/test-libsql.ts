import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * The real migrations as a flat list of statements, split the way drizzle emits
 * them (on its `--> statement-breakpoint` sentinel, comment lines stripped), for
 * feeding one at a time to an in-memory libSQL client in the query-module tests.
 *
 * The libSQL sibling of `test-d1.ts`'s `migrationFiles()`: same parse, but flat
 * (libSQL applies statements individually) rather than grouped per file.
 */
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
