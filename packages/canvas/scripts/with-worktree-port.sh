#!/usr/bin/env bash
#
# Per-worktree port assignment for the canvas dev stack and e2e runs.
#
# Hashes `basename(toplevel)` into a base port in [4520, 4900) (even) and
# exports:
#   PORT               — vite dev server port  (vite.config.ts reads this)
#   CANVAS_BRIDGE_PORT — bun bridge listen port (= PORT + 1; bridge.ts reads it,
#                        scripts/dev.ts derives the vite /api proxy target from it)
#   CUSTOM_PORT        — extension server listen port (= PORT + 2; server/extension-server.ts
#                        reads it, the bridge proxies /api/custom/* to it). Derived here
#                        because its 4512 default is a singleton two worktrees collide on.
#   CANVAS_EDGE_PORT   — edge Worker (wrangler dev) listen port (= PORT + 3; ADR-0018
#                        #263 — scripts/dev.ts derives the vite /v1 + /api/auth proxy
#                        target from it).
#   CANVAS_PTY_PORT    — Console pty-server listen port (= PORT + 4; ADR-0021.
#                        pty-server/server.mjs reads it; scripts/dev.ts passes it).
#
# STRIDE: the block below allocates on a stride of 8 because a worktree consumes FIVE
# consecutive ports (PORT..PORT+4). It was previously a stride of 2 while already
# consuming four, so adjacent slots silently overlapped — worktree A's CUSTOM_PORT was
# worktree B's vite PORT. Widening the stride costs slot count (47, was 190); a same-slot
# collision now fails loudly with EADDRINUSE instead of two stacks quietly sharing a port.
# Keep stride >= the number of ports exported here.
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
STRIDE=8
SLOTS=$(((PORT_HIGH - PORT_LOW) / STRIDE))

# md5 for a uniform-enough distribution (not cryptographic). openssl is present
# on both macOS and Linux.
HASH_HEX=$(printf '%s' "$WORKTREE_NAME_NORMALIZED" | openssl dgst -md5 | awk '{print $NF}')
HASH_NUM=$((16#${HASH_HEX:0:8}))
PORT=$((PORT_LOW + (HASH_NUM % SLOTS) * STRIDE))

export PORT
export CANVAS_BRIDGE_PORT=$((PORT + 1))
export CUSTOM_PORT=$((PORT + 2))
export CANVAS_EDGE_PORT=$((PORT + 3))
export CANVAS_PTY_PORT=$((PORT + 4))
export E2E_BASE_URL="http://localhost:${PORT}"
export E2E_MODE=1

exec "$@"
