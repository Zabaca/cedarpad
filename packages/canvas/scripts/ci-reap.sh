#!/usr/bin/env bash
# Kill dev-stack processes left behind by a CANCELLED e2e run.
#
# The e2e workflow runs on ONE self-hosted runner with `cancel-in-progress: true`, so a push
# that lands while a run is in flight kills that run mid-step. Playwright's `webServer`
# spawns the bridge, vite and `wrangler dev` as children; when the job is killed they are
# ORPHANED and keep their ports. The next run's `wrangler dev` then cannot come up —
#
#     ✘ [ERROR] Unexpected server response: 101
#
# — nothing listens on the edge port, and every test dies at auth setup with ECONNREFUSED.
# On 2026-08-04 that cost the v0.1.0 release its gate: two runs failed identically with 22
# of 23 tests never executing, while the same commit passed 23/23 locally.
#
# Re-running does NOT clear it. Only killing does, which is why this exists and why it runs
# BEFORE the suite (clean up whatever the last run left) as well as after it with
# `if: always()` (clean up after ourselves, cancellation included).
#
# Patterns match the full command line and name this repo's dev stack specifically, so a
# co-tenant process on the runner is never in scope. Ordered deliberately: `scripts/dev.ts`
# first, because its own SIGTERM handler cascades to the children it spawned — the rest are
# belt-and-braces for the case where that parent is already gone and they were reparented.
set -u

PATTERNS=(
  'scripts/dev.ts'      # the dev stack supervisor — SIGTERM here cascades
  'server/bridge.ts'    # the bun bridge
  'dev:web'             # vite, as dev.ts spawns it
  'wrangler dev'        # the edge Worker
  'workerd'             # wrangler's runtime, which can outlive its parent
)

reaped=0
for p in "${PATTERNS[@]}"; do
  # `|| true`: pkill exits 1 when nothing matched, which is the healthy case and must not
  # fail the step.
  if pkill -f "$p" 2>/dev/null; then
    echo "reaped  $p"
    reaped=$((reaped + 1))
  else
    echo "clean   $p"
  fi
done

# Let the OS release the ports before the next process tries to bind them. Skipped when
# there was nothing to reap, which is every healthy run.
[ "$reaped" -gt 0 ] && sleep 2

echo "ci-reap: ${reaped} pattern(s) had live processes"
exit 0
