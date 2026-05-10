#!/usr/bin/env bash
# Launches the cedarpad debug binary with cwd set to packages/app so its
# fallback sidecar path (`../src-sidecar/src/server.ts`) resolves. Used by
# the WebDriver harness because `tauri-webdriver` wants a single binary
# path; this wrapper restores the dev-time cwd assumption.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app_root="$(cd "$here/../.." && pwd)" # packages/app
bin="$app_root/src-tauri/target/debug/cedarpad"

if [ ! -x "$bin" ]; then
  echo "[launch-app] cedarpad debug binary not found at $bin" >&2
  echo "[launch-app] build with: cd $app_root/src-tauri && cargo build" >&2
  exit 1
fi

cd "$app_root/src-tauri"
# Log to a stable path so the spec can dig if things break.
log="${CEDARPAD_E2E_LAUNCH_LOG:-/tmp/cedarpad-e2e-launch.log}"
{
  echo "[launch-app] $(date)"
  echo "[launch-app] pwd=$(pwd)"
  echo "[launch-app] CEDARPAD_GLOBAL_DIR=${CEDARPAD_GLOBAL_DIR:-(unset)}"
  echo "[launch-app] CEDARPAD_E2E_REPO=${CEDARPAD_E2E_REPO:-(unset)}"
  echo "[launch-app] argv=$*"
} >> "$log"
exec "$bin" "$@" 2>> "$log"
