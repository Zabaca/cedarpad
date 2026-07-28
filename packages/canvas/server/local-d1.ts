// Where local dev's platform data layer lives on disk (ADR-0018, #263): miniflare's local D1,
// persisted under a per-worktree state directory. Production is untouched — it still runs on
// Turso, reached only by the edge.
//
// DEV TOOLING ONLY, and structurally so since #266: this module locates a directory and a file.
// It opens nothing. The bridge used to build a libSQL client from it — that was the temporary
// "one datastore in dev" bridge #263 put in and #266 took out — so the callers left are
// `scripts/wrangler-local.ts` (which points wrangler at the state dir) and the e2e spec that
// reads the database the edge Worker wrote, to assert a turn filed its Conversation.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where miniflare persists D1 under a `--persist-to` state dir. A miniflare layout
// constant, not a project path — the per-worktree part is the state dir itself.
const D1_SUBDIR = join('v3', 'd1', 'miniflare-D1DatabaseObject');

/**
 * The miniflare state directory backing local dev's D1.
 *
 * Worktree-safe (guideline 6 / ADR-0003): `with-worktree-db.sh` sets `CANVAS_D1_STATE`
 * to a per-worktree directory, so parallel worktrees never share one local D1. Unset
 * falls back to this package's canonical `.wrangler/state`, so a plain `bun run dev`
 * needs no wrapper.
 */
export function localD1StateDir(): string {
  return (
    process.env.CANVAS_D1_STATE ?? fileURLToPath(new URL('../.wrangler/state', import.meta.url))
  );
}

/**
 * The SQLite file miniflare keeps the local D1 database in, or null when migrations
 * have never been applied to this state dir.
 *
 * `metadata.sqlite` is miniflare's own bookkeeping store, not a database.
 */
export function localD1File(stateDir: string): string | null {
  const dir = join(stateDir, D1_SUBDIR);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  return file ? join(dir, file) : null;
}

/**
 * The same file, but insisting it exists — for a caller that is about to read it and would
 * otherwise see a confusing empty result. Nothing is migrated here (`bun run
 * webpoc:db:migrate:local` owns that), which is why an unmigrated state dir is an error naming
 * the command rather than a silently absent database.
 */
export function requireLocalD1File(stateDir: string = localD1StateDir()): string {
  const file = localD1File(stateDir);
  if (!file) {
    throw new Error(
      `No local D1 database in ${stateDir}. Run \`bun run webpoc:db:migrate:local\` first (ADR-0018).`,
    );
  }
  return file;
}
