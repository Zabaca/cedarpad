#!/usr/bin/env bash
# Deploy origin/main to the workspace VM (cedarpad-ws on ryzen-9) — the deploy target that
# serves the default workspace. The Cloudflare container (deploy.sh) is not touched.
#
#   1. `bun run apply workspace`: ws-app fetches origin/main ON the VM, hard-resets to it,
#      reinstalls and stamps build-rev/version; the rest of the environment is a no-op when
#      already converged.
#   2. Stop the dev stack. The supervisor is left running; the Worker's next request boots
#      the stack on the new checkout (ws-supervisor.ts) — without this, a bridge started
#      before the converge keeps serving the old code from memory.
#   3. Fail unless the VM's build-rev stamp is origin/main.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
VM="ryzen-9:cedarpad-ws"
APP=/app/agent-canvas

WANT=$(git -C "$REPO_ROOT" ls-remote origin refs/heads/main | cut -c1-7)
echo "→ deploying origin/main ($WANT) to $VM"

( cd "$REPO_ROOT" && bun run apply workspace )

echo "→ restarting the dev stack onto the new checkout"
incus exec "$VM" --project zabaca -- sh -c \
  'P=$(pgrep -f "[b]un run scripts/dev.ts" | head -1); if [ -n "$P" ]; then kill -TERM "$P"; echo "  stopped pid $P — the next request boots the new code"; else echo "  not running — the next request boots the new code"; fi'

GOT=$(incus exec "$VM" --project zabaca -- cat "$APP/packages/canvas/server/build-rev.txt")
VERSION=$(incus exec "$VM" --project zabaca -- cat "$APP/packages/canvas/server/version.txt")
if [ "$GOT" != "$WANT" ]; then
  echo "❌ VM is stamped $GOT, expected $WANT"
  exit 1
fi
echo "✅ VM on $GOT (v$VERSION)"
