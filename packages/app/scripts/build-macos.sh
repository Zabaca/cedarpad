#!/usr/bin/env bash
# Build a self-installable cedarpad.app for macOS.
#
# Steps:
#   1. Bundle the Bun sidecar to dist-sidecar/server.js (release-mode dev
#      still requires Bun on PATH — release-mode `bun build --compile`
#      single-binary sidecar is deferred per ADR-0005 risk #1).
#   2. Build the Vite renderer.
#   3. Run `tauri build` with a worktree-scoped CARGO_TARGET_DIR so
#      parallel worktrees never collide on Rust artifacts.
#   4. Ad-hoc codesign the produced .app (signingIdentity "-" in
#      tauri.conf.json + a defensive `codesign --force` here in case the
#      bundler skipped signing because no real identity is configured).
#   5. Copy the .app into packages/app/build/ for easy access.
#
# Output: packages/app/build/cedarpad.app  (and a .dmg if Tauri produced one).
#
# Re-runnable. No global state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
WORKTREE_NAME="$(basename "$REPO_ROOT")"

# Worktree-scoped target dir (CLAUDE.md §6). Default lives under the
# user's cargo cache so different worktrees don't fight over a single
# `target/`. Override via CARGO_TARGET_DIR if you want it elsewhere.
DEFAULT_TARGET_DIR="${CARGO_HOME:-$HOME/.cargo}/cedarpad-build/${WORKTREE_NAME}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$DEFAULT_TARGET_DIR}"
mkdir -p "$CARGO_TARGET_DIR"

OUT_DIR="$APP_DIR/build"
mkdir -p "$OUT_DIR"

cd "$APP_DIR"

echo "==> worktree:        $WORKTREE_NAME"
echo "==> CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "==> OUT_DIR=         $OUT_DIR"

echo "==> [1/4] building sidecar (release layout)"
bun run build:sidecar:release

echo "==> [2/4] building renderer"
bun run build:vite

echo "==> [3/4] building Tauri release bundle"
# `tauri build` runs `cargo build --release` under the hood and uses
# CARGO_TARGET_DIR. With macOS.signingIdentity "-" it ad-hoc signs the
# .app on its way out.
bunx --bun tauri build

BUNDLE_DIR="$CARGO_TARGET_DIR/release/bundle/macos"
APP_PATH="$BUNDLE_DIR/cedarpad.app"

if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: expected $APP_PATH not found" >&2
  ls -la "$CARGO_TARGET_DIR/release/bundle" 2>&1 || true
  exit 1
fi

echo "==> [4/4] verifying / re-applying ad-hoc signature"
# Re-sign defensively. `--force --deep -s -` ad-hoc signs everything in
# the bundle; harmless if Tauri already did it. Without *some* signature
# (even ad-hoc) macOS Gatekeeper refuses to launch the binary at all on
# Apple-silicon machines — "killed: 9" with no dialog.
codesign --force --deep --sign - --timestamp=none "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# Copy into packages/app/build/ for easy access. Wipe any prior copy.
rm -rf "$OUT_DIR/cedarpad.app"
cp -R "$APP_PATH" "$OUT_DIR/cedarpad.app"

echo
echo "==> done"
echo "    .app:  $OUT_DIR/cedarpad.app"
ls -1 "$OUT_DIR" | sed 's/^/    /'
echo
echo "    Install:  cp -R $OUT_DIR/cedarpad.app /Applications/"
echo "    Or open:  open $OUT_DIR/cedarpad.app"
