/**
 * Playwright global setup.
 *
 * with-worktree-db.sh derives this worktree's miniflare state dir (CANVAS_D1_STATE),
 * but nothing migrates on boot any more (ADR-0018, #263) — so apply the migrations to
 * the local D1 here, before the dev stack starts. Idempotent: a second run is a no-op.
 */
import { spawnWrangler } from '../scripts/wrangler-local.ts';

export default async function globalSetup() {
  const proc = await spawnWrangler(['d1', 'migrations', 'apply', 'PLATFORM_DB', '--local']);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`local D1 migrations failed (exit ${code})`);
}
