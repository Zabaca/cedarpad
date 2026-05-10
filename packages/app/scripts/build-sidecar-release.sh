#!/usr/bin/env bash
# Build the Bun sidecar for release mode.
#
# The dev sidecar is invoked as `bun run src-sidecar/src/server.ts` and
# resolves dependencies via the workspace `node_modules` tree. Release
# bundles the sidecar into a single JS file but `@libsql/*` natives
# (Mach-O `.node` files) can't be inlined — they're externalised from
# the bundle and shipped as a sibling `node_modules` tree alongside
# `server.js`. The Tauri release loader does `bun run server.js` against
# this layout (see lib.rs::start_sidecar).
#
# Output:
#   dist-sidecar/server.js                              (bundled JS)
#   dist-sidecar/node_modules/@libsql/<platform>/...    (native binding)
#   dist-sidecar/node_modules/libsql/...                (JS shim that
#                                                       loads the native)
#
# Re-runnable. Wipes dist-sidecar/ on every run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# Output into src-tauri/sidecar/ so Tauri's resource glob can include it
# without escaping src-tauri/ (".." resources land under Resources/_up_/
# which makes runtime path resolution awkward).
OUT="$APP_DIR/src-tauri/sidecar"

cd "$APP_DIR"

# Detect target platform package — only darwin-arm64 is wired today.
# Add additional cases here when expanding to Intel macs / Linux / Windows.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) LIBSQL_PLATFORM_PKG="@libsql/darwin-arm64" ;;
  Darwin/x86_64) LIBSQL_PLATFORM_PKG="@libsql/darwin-x64" ;;
  *)
    echo "ERROR: unsupported build host $(uname -s)/$(uname -m)" >&2
    echo "       expected Darwin/arm64 or Darwin/x86_64" >&2
    exit 1
    ;;
esac

echo "==> sidecar-release: target=$LIBSQL_PLATFORM_PKG"

rm -rf "$OUT"
mkdir -p "$OUT/node_modules/@libsql"
mkdir -p "$OUT/node_modules/libsql"

# 1. Bundle the JS. Externalise @libsql/* and libsql so the runtime
#    `require()` resolves against the colocated node_modules tree (where
#    we'll drop the natives next).
bun build src-sidecar/src/server.ts \
  --outfile "$OUT/server.js" \
  --target=bun \
  --external '@libsql/*' \
  --external libsql

# 2. Copy the platform native package and the libsql shim it loads.
LIBSQL_PLATFORM_SRC="$REPO_ROOT/node_modules/.bun/${LIBSQL_PLATFORM_PKG/\//+}@*/node_modules/${LIBSQL_PLATFORM_PKG}"
# Glob-resolve the bun-isolated path to a single matched dir.
matches=( $(ls -d $LIBSQL_PLATFORM_SRC 2>/dev/null || true) )
if [ "${#matches[@]}" -eq 0 ]; then
  echo "ERROR: native package not found at $LIBSQL_PLATFORM_SRC" >&2
  echo "       run \`bun install\` first" >&2
  exit 1
fi
NATIVE_SRC="${matches[0]}"
cp -R "$NATIVE_SRC" "$OUT/node_modules/$LIBSQL_PLATFORM_PKG"
echo "==> copied native: $NATIVE_SRC"

LIBSQL_SHIM_SRC=$(ls -d "$REPO_ROOT/node_modules/.bun/libsql@"*/node_modules/libsql 2>/dev/null | head -1 || true)
if [ -z "$LIBSQL_SHIM_SRC" ]; then
  echo "ERROR: libsql shim not found under $REPO_ROOT/node_modules/.bun/libsql@*" >&2
  exit 1
fi
cp -R "$LIBSQL_SHIM_SRC"/* "$OUT/node_modules/libsql/"
echo "==> copied shim:   $LIBSQL_SHIM_SRC"

echo "==> dist-sidecar layout:"
find "$OUT" -maxdepth 4 -print | sed "s|$OUT|dist-sidecar|" | sort
