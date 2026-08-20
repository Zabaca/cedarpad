import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The platform data layer's Drizzle migrations, flattened to individual SQL statements for the
// in-memory libSQL databases the worker's bun tests stand up. Shared by every worker *.test.ts
// that builds a fresh DB, so the parse — drop `-- ` comment lines, split on the Drizzle
// statement-breakpoint — lives in exactly one place instead of a byte-identical copy per suite.
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));

export function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}
