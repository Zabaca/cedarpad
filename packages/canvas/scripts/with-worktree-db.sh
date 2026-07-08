#!/usr/bin/env bash
#
# Per-worktree dev-DB isolation (libSQL, NOT Postgres).
#
# The canvas bridge backs the mounted web-poc with a local libSQL FILE in dev
# (prod uses remote Turso). This wrapper derives a per-worktree file path from
# `basename(toplevel)` and exports it as CANVAS_DEV_DB — the env var
# server/bridge.ts reads (falling back to the canonical .web-poc-dev.db when
# unset, so the plain `bun run dev` is unchanged).
#
# No createdb / schema push is needed: libSQL creates the file on open and the
# bridge runs its idempotent migrations on boot. So this is a thin, fast
# passthrough — it only computes the path and execs.

set -euo pipefail

TOPLEVEL=$(git rev-parse --show-toplevel)
WORKTREE_NAME=$(basename "$TOPLEVEL")
WORKTREE_NAME_NORMALIZED=$(echo "$WORKTREE_NAME" | tr '[:upper:]' '[:lower:]' | tr '-' '_')

if ! [[ "$WORKTREE_NAME_NORMALIZED" =~ ^[a-z0-9_]+$ ]]; then
  echo "with-worktree-db: refusing to derive DB path from '$WORKTREE_NAME'" >&2
  exit 1
fi

# libSQL wants a file: URL. Keep it next to the canonical dev DB so it inherits
# the same .gitignore rule (.web-poc-dev-*.db*).
DB_PATH="${TOPLEVEL}/packages/canvas/.web-poc-dev-${WORKTREE_NAME_NORMALIZED}.db"
export CANVAS_DEV_DB="file:${DB_PATH}"

exec "$@"
