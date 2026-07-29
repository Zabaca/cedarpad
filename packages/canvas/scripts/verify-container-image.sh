#!/usr/bin/env bash
# Verify the CONTAINER image actually rolled — the check deploy.sh does not do.
#
# deploy.sh polls /api/buildrev, which proves the WORKER is serving the new SHA. It says
# nothing about the container image. On 2026-07-28 a rollout reported "completed" while
# leaving the application on the previous image, producing a new-worker/old-container
# split-brain that stayed invisible until the first idle-sleep cold boot.
#
# Issue #342: `version` / `configuration.image` only advance when the rollout COMPLETES,
# so reading them while a rollout is still `progressing` races it. This waits for the
# newest rollout to leave `progressing` (shared logic in lib/rollout-wait.sh, also used by
# deploy.sh) before comparing anything, and reports which case it hit — still rolling vs.
# rolled out and stale — since those need different human responses.
#
# Run from the repo root (any checkout).
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/rollout-wait.sh"

ACCT=99a19e584439be0568f33aad0477372b
APP=a03ba78e-7285-4761-b91d-ba494056087c   # agent-canvas-sandbox
SECRETS=${SECRETS:-packages/infra/environments/production/secrets.yaml}

echo "→ waiting for the newest rollout to leave 'progressing' (issue #342)"
ROLLOUT=$(wait_for_rollout "$SECRETS" "$ACCT" "$APP" "${ROLLOUT_WAIT_TIMEOUT:-180}" 5)

sops exec-env "$SECRETS" 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/'"$ACCT"'/containers/applications"' \
| python3 -c "
import sys, json
apps = json.load(sys.stdin)['result']
a = [x for x in apps if x['name'] == 'agent-canvas-sandbox'][0]
print('app image   :', a['configuration']['image'].split('@')[1])
print('app version :', a['version'], '| updated:', a['updated_at'][:19])
print('health      :', a['health']['instances'])
"

sops exec-env "$SECRETS" 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/'"$ACCT"'/containers/applications/'"$APP"'/rollouts"' \
| python3 -c "
import sys, json
r = json.load(sys.stdin)['result'][0]
print('rollout     :', r['id'][:8], r['status'], '|', r['created_at'][:19])
print('  from      :', r['current_configuration']['image'].split('@')[1])
print('  to        :', r['target_configuration']['image'].split('@')[1])
print()
print('VERDICT: app image must equal rollout TO image.')
print('         If it equals FROM, the rollout no-opped and the container is stale')
print('         regardless of what its status says.')
"

case "$ROLLOUT" in
  ERROR*)
    echo
    echo "⚠️  could not read rollout status (${ROLLOUT#ERROR }) — verdict above is unverified against the race; read it with that caveat."
    ;;
  PROGRESSING*)
    set -- $ROLLOUT
    echo
    echo "⚠️  rollout still progressing after ${2}s when this ran — the mismatch (if any) above may"
    echo "   just be the race (issue #342), not a real stale-image defect. Do NOT re-run a deploy"
    echo "   off this alone; wait and re-check."
    ;;
  DONE*)
    set -- $ROLLOUT
    RSTATUS=$2; CUR=$3; TARGET=$4
    echo
    if [ "$CUR" != "$TARGET" ]; then
      echo "❌ rollout reached '$RSTATUS' with current != target — this is the real stale-image defect (2026-07-28 incident), not the race."
      exit 1
    else
      echo "✅ rollout reached '$RSTATUS' with current == target — no race, no stale image."
    fi
    ;;
esac
