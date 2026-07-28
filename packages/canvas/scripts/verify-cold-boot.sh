#!/usr/bin/env bash
# Prove the container can COLD boot on the currently-deployed image.
#
# WHY THIS EXISTS (incident 2026-07-28). A deploy can verify green and still be broken.
# The D1-cutover deploy passed its buildRev poll — the rollout had started instances on
# the new image and they answered correctly — while the container application's stored
# `configuration.image` was never updated off the previous digest. Serving instances were
# right; the configuration every FUTURE cold boot reads was not.
#
# Nothing surfaced for ~15 minutes. Then the idle reaper (STALE_MS, server/bridge.ts)
# exited the process exactly as designed, the next request cold-booted the stale image,
# and every container-bound request hung. /__bootlog hung too — it calls getProcessLogs on
# the Sandbox DO, which was itself blocked on the container that would not boot, so the
# diagnostic died with the thing it diagnoses.
#
# So "verified live" means "verified warm" unless something forces a cold start. This does.
#
# HOW: /api/buildrev is public (worker/index.ts) and routes through serveWorkspace to the
# container, so it is itself a cold-boot trigger and needs no session. Idle past STALE_MS
# with no live tab, then hit it and time the response.
#
#   IMPORTANT: close every canvas tab first. A live tab beats /api/alive and keeps the
#   container awake, which makes this check silently vacuous — it would time a warm hit.
#
# Usage:  bash packages/canvas/scripts/verify-cold-boot.sh [expected-sha]
set -uo pipefail

URL=${CANVAS_URL:-https://app.cedarpad.com}
EXPECT=${1:-}
# STALE_MS is 90s; wait past it with margin so the reaper has actually run.
IDLE=${IDLE_SECONDS:-120}
# A cold boot restores the workspace from R2 before serving (scripts/container-start.ts),
# so it is slow by nature. a24676b allows 120s before killProcess; allow more than that.
BOOT_TIMEOUT=${BOOT_TIMEOUT:-300}
# A genuine cold boot restores the workspace from R2 first and took 8s in production. A
# sub-2s response means the container was already warm and this check ran vacuously.
MIN_COLD_SECONDS=${MIN_COLD_SECONDS:-2}

ACCT=99a19e584439be0568f33aad0477372b
SECRETS=${SECRETS:-packages/infra/environments/production/secrets.yaml}

echo "→ current served buildRev (may be warm):"
WARM=$(curl -s --max-time 30 "$URL/api/buildrev" | python3 -c "import sys,json;print(json.load(sys.stdin).get('buildRev','?'))" 2>/dev/null || echo "?")
echo "   $WARM"

echo "→ idling ${IDLE}s so the reaper exits the container (STALE_MS=90s)."
echo "   CLOSE EVERY CANVAS TAB — a live tab beats /api/alive and this check becomes vacuous."
sleep "$IDLE"

echo "→ checking the container application's instance state before the timed request"
# A live instance means the reaper never fired (a tab was still open, or the idle window
# was too short) and the request below would hit a WARM container. Same API pattern as
# verify-container-image.sh.
INSTANCES=$(sops exec-env "$SECRETS" 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/'"$ACCT"'/containers/applications"' 2>/dev/null \
  | python3 -c "
import sys, json
apps = json.load(sys.stdin)['result']
a = [x for x in apps if x['name'] == 'agent-canvas-sandbox'][0]
instances = a['health']['instances']
total = sum(instances.values()) if isinstance(instances, dict) else instances
print(total)
" 2>/dev/null)

if [ -z "$INSTANCES" ]; then
  echo "❌ could not read instance state from the Cloudflare API — refusing to report a cold"
  echo "   boot this script cannot prove. Fix the API call first."
  exit 1
fi
if [ "$INSTANCES" -gt 0 ]; then
  echo "❌ NOT A COLD BOOT — the container application still has $INSTANCES running instance(s)."
  echo "   The reaper never fired (a tab was still open, or IDLE_SECONDS was too short), so"
  echo "   the request below would hit a WARM container and this check would pass vacuously"
  echo "   — exactly what happened on 2026-07-28 (printed success at 0s for a check that did"
  echo "   not run; a forced recycle then showed the real cold boot took 8s)."
  echo "   Force a stop with: curl -X POST $URL/__recycle   (or close every tab and re-run)."
  exit 1
fi

echo "→ cold request (up to ${BOOT_TIMEOUT}s)"
START=$(date +%s)
COLD=$(curl -s --max-time "$BOOT_TIMEOUT" "$URL/api/buildrev" | python3 -c "import sys,json;print(json.load(sys.stdin).get('buildRev','?'))" 2>/dev/null || echo "?")
ELAPSED=$(( $(date +%s) - START ))

if [ "$COLD" = "?" ]; then
  echo "❌ COLD BOOT FAILED — no response in ${BOOT_TIMEOUT}s."
  echo "   This is the 2026-07-28 signature. Check the STORED container image first:"
  echo "     bash packages/canvas/scripts/verify-container-image.sh"
  echo "   Do NOT assume the deploy was fine because it verified green — it did last time too."
  exit 1
fi

if [ "$ELAPSED" -lt "$MIN_COLD_SECONDS" ]; then
  echo "❌ NOT A COLD BOOT — responded in ${ELAPSED}s, which is implausibly fast."
  echo "   A genuine cold boot restores the workspace from R2 and took 8s in production."
  echo "   This measured a WARM hit, not a cold boot. Force a stop with:"
  echo "     curl -X POST $URL/__recycle"
  echo "   then re-run this script."
  exit 1
fi

echo "✅ cold boot served buildRev=$COLD in ${ELAPSED}s"
if [ -n "$EXPECT" ] && [ "$COLD" != "$EXPECT" ]; then
  echo "❌ expected $EXPECT — the container cold-booted the WRONG image."
  exit 1
fi
echo "✅ cold boot verified${EXPECT:+ (== $EXPECT)}"
