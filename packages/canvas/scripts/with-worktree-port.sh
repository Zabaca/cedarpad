#!/usr/bin/env bash
#
# Per-worktree port assignment for the canvas dev stack and e2e runs.
#
# Hashes `basename(toplevel)` into a base port in [4520, 4900) (even) and
# exports:
#   PORT               — vite dev server port  (vite.config.ts reads this)
#   CANVAS_BRIDGE_PORT — bun bridge listen port (= PORT + 1; bridge.ts reads it,
#                        scripts/dev.ts derives the vite /api proxy target from it)
#   CANVAS_EDGE_PORT   — edge Worker (wrangler dev) listen port (= PORT + 3; ADR-0018
#                        #263 — scripts/dev.ts derives the vite /v1 + /api/auth proxy
#                        target from it). +3, not +2: 4512 is the extension server's.
#   E2E_BASE_URL       — http://localhost:$PORT (Playwright baseURL)
#   E2E_MODE=1         — flag e2e-aware code paths can read to short-circuit
#                        real auth / external calls for hermetic e2e. Consumers
#                        MUST belt-and-suspenders this with a non-prod guard.
#
# The main checkout and every worktree get a deterministic, stable pair, so
# `lsof -i :$PORT` is always informative and two worktrees never collide.
#
# Defaults (4510/4511) are preserved when this wrapper is NOT used: `bun run dev`
# with no env is unchanged.

set -euo pipefail

TOPLEVEL=$(git rev-parse --show-toplevel)
WORKTREE_NAME=$(basename "$TOPLEVEL")
WORKTREE_NAME_NORMALIZED=$(echo "$WORKTREE_NAME" | tr '[:upper:]' '[:lower:]' | tr '-' '_')

if ! [[ "$WORKTREE_NAME_NORMALIZED" =~ ^[a-z0-9_]+$ ]]; then
  echo "with-worktree-port: refusing to derive port from '$WORKTREE_NAME'" >&2
  exit 1
fi

PORT_LOW=4520
PORT_HIGH=4900
SLOTS=$(((PORT_HIGH - PORT_LOW) / 2))

# md5 for a uniform-enough distribution (not cryptographic). openssl is present
# on both macOS and Linux.
HASH_HEX=$(printf '%s' "$WORKTREE_NAME_NORMALIZED" | openssl dgst -md5 | awk '{print $NF}')
HASH_NUM=$((16#${HASH_HEX:0:8}))
PORT=$((PORT_LOW + (HASH_NUM % SLOTS) * 2))

export PORT
export CANVAS_BRIDGE_PORT=$((PORT + 1))
export CANVAS_EDGE_PORT=$((PORT + 3))
export E2E_BASE_URL="http://localhost:${PORT}"
export E2E_MODE=1

exec "$@"
