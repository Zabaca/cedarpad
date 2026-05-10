#!/usr/bin/env bash
# Worktree-scoped env wrapper for cedarpad/app dev/test commands.
#
# Derives a stable per-worktree id from the basename of the worktree top-level
# directory and exports:
#   CEDARPAD_TMP   — per-worktree temp dir for test fixtures
#   PORT           — Vite dev server port (offset from 1420)
#   E2E_PORT       — Playwright base port (offset from 4420)
#   VITE_DEV_PORT  — alias of PORT for vite.config.ts
#
# Usage: ./scripts/with-worktree-env.sh <command...>
set -euo pipefail

TOPLEVEL="$(git rev-parse --show-toplevel)"
WORKTREE_NAME="$(basename "$TOPLEVEL")"

# Stable hash → 0..199
HASH_HEX="$(printf '%s' "$WORKTREE_NAME" | shasum -a 256 | cut -c1-8)"
HASH_DEC="$((16#$HASH_HEX))"
OFFSET=$((HASH_DEC % 200))

export PORT="${PORT:-$((1420 + OFFSET))}"
export VITE_DEV_PORT="$PORT"
export E2E_PORT="${E2E_PORT:-$((4420 + OFFSET))}"

CEDARPAD_TMP_DEFAULT="${TMPDIR:-/tmp}/cedarpad-${WORKTREE_NAME}"
export CEDARPAD_TMP="${CEDARPAD_TMP:-$CEDARPAD_TMP_DEFAULT}"
mkdir -p "$CEDARPAD_TMP"

exec "$@"
