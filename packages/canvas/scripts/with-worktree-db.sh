#!/usr/bin/env bash
#
# Per-worktree isolation for the LOCAL platform data layer.
#
# Since ADR-0018 (#263) local dev's platform data layer is miniflare's local D1, bound
# to the edge Worker — not a libSQL file the bridge migrates on boot. So the thing to
# isolate is miniflare's STATE DIRECTORY: this wrapper derives one from
# `basename(toplevel)` and exports it as CANVAS_D1_STATE. Both the edge Worker
# (`wrangler dev --persist-to`) and the bridge (which opens the same D1 file) read it.
#
# Guideline 6 / ADR-0003 holds exactly as before: two worktrees get two state dirs, so
# they never share a database. Unset falls back to this package's canonical
# .wrangler/state, so a plain `bun run dev` needs no wrapper.
#
# Nothing is created here — `bun run webpoc:db:migrate:local` applies the migrations
# (there is no boot-time auto-migration any more).

set -euo pipefail

TOPLEVEL=$(git rev-parse --show-toplevel)
WORKTREE_NAME=$(basename "$TOPLEVEL")
WORKTREE_NAME_NORMALIZED=$(echo "$WORKTREE_NAME" | tr '[:upper:]' '[:lower:]' | tr '-' '_')

if ! [[ "$WORKTREE_NAME_NORMALIZED" =~ ^[a-z0-9_]+$ ]]; then
  echo "with-worktree-db: refusing to derive a D1 state dir from '$WORKTREE_NAME'" >&2
  exit 1
fi

# Under .wrangler/ so it inherits the repo's existing ignore rule.
export CANVAS_D1_STATE="${TOPLEVEL}/packages/canvas/.wrangler/state-${WORKTREE_NAME_NORMALIZED}"

exec "$@"
