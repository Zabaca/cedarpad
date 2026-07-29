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
# Runnable from ANY directory: the secrets path is resolved from this script's own
# location, not the caller's CWD. It used to default to a repo-root-relative path, so
# running it from packages/canvas made every `sops exec-env` fail — and because the
# failure arrived as an EMPTY pipe rather than a non-zero exit, it surfaced as a python
# JSONDecodeError and an "unverified" verdict rather than "I could not find the secrets".
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/rollout-wait.sh"

ACCT=99a19e584439be0568f33aad0477372b
APP=a03ba78e-7285-4761-b91d-ba494056087c   # agent-canvas-sandbox
SECRETS=${SECRETS:-$SCRIPT_DIR/../../infra/environments/production/secrets.yaml}
if [ ! -f "$SECRETS" ]; then
  echo "❌ secrets file not found: $SECRETS" >&2
  echo "   Pass SECRETS=<path> explicitly." >&2
  exit 1
fi

echo "→ waiting for the newest rollout to leave 'progressing' (issue #342)"
ROLLOUT=$(wait_for_rollout "$SECRETS" "$ACCT" "$APP" "${ROLLOUT_WAIT_TIMEOUT:-180}" 5)

sops exec-env "$SECRETS" 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/'"$ACCT"'/containers/applications/'"$APP"'/rollouts"' \
| python3 -c "
import sys, json
r = json.load(sys.stdin)['result'][0]
print('rollout     :', r['id'][:8], r['status'], '|', r['created_at'][:19])
print('  from      :', r['current_configuration']['image'].split('@')[1])
print('  to        :', r['target_configuration']['image'].split('@')[1])
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
    RSTATUS=$2; TARGET=$4
    echo
    # Compare the APPLICATION's stored image against the rollout's TARGET.
    #
    # NOT the rollout's own current-vs-target: on a COMPLETED rollout
    # `current_configuration` is the image it rolled FROM, so those two differ on every
    # healthy deploy. This script used to compare exactly that and would have reported a
    # stale image every single time it ran on a good deploy.
    #
    # And the stored image is POLLED, not read once: the application record advances some
    # time after the rollout reports completed (150s observed on 2026-07-29), so a single
    # read is the false alarm this file is supposed to distinguish from a real one.
    echo "→ waiting for the application's stored image to reach the rollout target"
    IMG=$(wait_for_stored_image "$SECRETS" "$ACCT" agent-canvas-sandbox "$TARGET" "${STORED_IMAGE_WAIT_TIMEOUT:-300}" 15)
    set -- $IMG
    case "$IMG" in
      SKIP*)
        echo "⚠️  could not read the application record (${IMG#SKIP }) — no verdict."
        ;;
      MATCH*)
        echo "✅ rollout '$RSTATUS'; application stored image == rollout target ($2, app v$3, failed instances: $4)"
        ;;
      STALE*)
        echo "❌ rollout reached '$RSTATUS', but after ${5}s the application is still on $2 (v$3),"
        echo "   not its rollout target $TARGET."
        echo "   Both settle races are waited out, so this is the real stale-image defect"
        echo "   (2026-07-28 incident): cold boots will wedge on the old image."
        exit 1
        ;;
    esac
    ;;
esac
