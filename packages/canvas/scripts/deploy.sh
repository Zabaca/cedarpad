#!/usr/bin/env bash
# Verified deploy of agent-canvas. The point: "is the new code live?" becomes a
# deterministic yes/no instead of a guess. It stamps the current git SHA into the
# image, deploys via zbc (which rolls the container onto the new image), then POLLS the
# public /api/buildrev until the SERVED buildRev equals the SHA we shipped. Success means
# the new code is provably serving; otherwise it fails loudly.
#
# Run it in the background (it can take ~10-15min): the rollout + cold boot are slow.
#   bash packages/canvas/scripts/deploy.sh
# Env overrides: CANVAS_URL (default https://poc.cedarpad.com), POLL_TRIES (default 60).
set -uo pipefail

cd "$(dirname "$0")/.."                       # packages/agent-canvas
REPO_ROOT=$(git rev-parse --show-toplevel)
SHA=$(git rev-parse --short HEAD)
URL=${CANVAS_URL:-https://poc.cedarpad.com}
TRIES=${POLL_TRIES:-60}

echo "→ stamping build-rev $SHA (uncommitted change = stamp is the working SHA, not what's deployed)"
git diff --quiet && git diff --cached --quiet || echo "  ⚠️  working tree dirty — buildRev reflects HEAD, not your uncommitted edits"
printf '%s' "$SHA" > server/build-rev.txt

# Headless Docker config (keychain/buildx workaround — see memory cf-container-deploy-headless).
DC=$(mktemp -d)
python3 -c "import json; c=json.load(open('$HOME/.docker/config.json')); c.pop('credsStore',None); c.pop('credStore',None); json.dump(c,open('$DC/config.json','w'))"
for f in cli-plugins contexts buildx; do [ -e "$HOME/.docker/$f" ] && ln -s "$HOME/.docker/$f" "$DC/$f"; done
cleanup() { rm -rf "$DC"; }
trap cleanup EXIT

# Notebook SPA static build (PRD #49 slice #58): wrangler's `assets` binding bundles
# web-poc/dist, so it must exist before zbc runs `wrangler deploy`. The zbc cloudflare
# module has no build hook, so build it here.
echo "→ building Notebook SPA (web-poc/dist)"
bun run webpoc:build || { echo "❌ webpoc:build failed"; exit 1; }

echo "→ zbc apply production canvas (build + deploy + push secrets)"
( cd "$REPO_ROOT" && DOCKER_CONFIG="$DC" bunx @zabaca/zbc apply production canvas ) || { echo "❌ zbc apply failed"; exit 1; }

# Verify against the public /api/buildrev (#74). Post-#47 the edge Better Auth gate is
# the sole gate, so /api/status and /__recycle serve the login page to an unauthenticated
# script. /api/buildrev is the ONE public path (only the SHA, no health/client fields) and
# reaches the container ahead of the gate, so the verify loop needs no session/secret. The
# explicit /__recycle kick is gone: `zbc apply` above rolls the container onto the new
# image immediately, so polling the served SHA alone confirms the rollout.
echo "→ verifying served buildRev == $SHA (cold boot + rollout settle; up to $((TRIES*5))s)"
cur="?"
for i in $(seq 1 "$TRIES"); do
  cur=$(curl -s --max-time 20 "$URL/api/buildrev" \
        | python3 -c "import sys,json; print(json.load(sys.stdin).get('buildRev','?'))" 2>/dev/null || echo "?")
  if [ "$cur" = "$SHA" ]; then echo "✅ LIVE: $SHA is serving at $URL"; exit 0; fi
  printf '   [%02d/%s] served=%s expected=%s\n' "$i" "$TRIES" "$cur" "$SHA"
  sleep 5
done
echo "❌ TIMEOUT: served=$cur expected=$SHA — the new code is NOT confirmed live"
exit 1
