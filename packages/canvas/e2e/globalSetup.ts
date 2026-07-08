/**
 * Playwright global setup.
 *
 * with-worktree-db.sh already derives the per-worktree CANVAS_DEV_DB path, and
 * the bridge runs its idempotent libSQL migrations on boot — so by the time a
 * spec runs, the DB is in a known-good state. Keep this a no-op until a future
 * need (seeding a test user for the fuller Shell flow, etc.) requires setup the
 * wrapper shouldn't own. Prefer pushing DB/bootstrap logic down into
 * with-worktree-db.sh so non-Playwright runs get it too.
 */
export default async function globalSetup() {
  // intentionally empty
}
