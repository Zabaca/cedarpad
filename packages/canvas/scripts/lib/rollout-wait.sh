# Shared rollout-status polling (issue #342).
#
# A container application's `version` and `configuration.image` only advance
# when a progressive rollout COMPLETES. deploy.sh's stored-image check and
# verify-container-image.sh both used to read those fields immediately after
# `zbc apply`, while the rollout was still `progressing` — comparing against
# values that had not updated yet. Observed live: scheduling: 3 -> starting: 3
# -> healthy: 2, starting: 1 -> healthy: 3, and only THEN did version/image
# flip. The false-positive failure this produced told the operator to re-run
# the deploy, which replaced the healthy in-flight rollout with a new one
# (v146 -> status "replaced", superseded by v147).
#
# wait_for_rollout waits for the newest rollout to leave "progressing" (or a
# bounded timeout, whichever comes first) and reports which one happened —
# callers must NOT compare stored/target images while a rollout is still
# progressing; that is the race this file exists to close.
#
# Source this file, then call:
#   wait_for_rollout SECRETS_FILE ACCOUNT APP_ID [TIMEOUT_SECS] [POLL_INTERVAL_SECS]
#
# Prints exactly one line to stdout:
#   PROGRESSING <elapsed_secs>                        -- timed out, still rolling
#   DONE <status> <current_image_digest> <target_image_digest>  -- left progressing
#   ERROR <message with no spaces replaced by _>       -- API call/parse failed
#
# Fixture-testable: parse_rollouts_response() below is the pure part (stdin
# JSON -> one of the same three line shapes), and is what the unit tests in
# this PR exercise directly, without hitting the network.

parse_rollouts_response() {
  python3 -c "
import sys, json

try:
    data = json.load(sys.stdin)
except Exception as e:
    print('ERROR could_not_parse_rollouts_response:_%s' % e)
    raise SystemExit

results = data.get('result')
if not results:
    print('ERROR no_rollouts_returned')
    raise SystemExit

r = results[0]  # newest first, per the Cloudflare containers rollouts API
status = r.get('status')
if status == 'progressing':
    print('PROGRESSING')
    raise SystemExit

cur = ((r.get('current_configuration') or {}).get('image') or '').split('@')[-1]
tgt = ((r.get('target_configuration') or {}).get('image') or '').split('@')[-1]
if not cur or not tgt:
    print('ERROR terminal_rollout_missing_image_fields')
    raise SystemExit
print('DONE %s %s %s' % (status, cur, tgt))
"
}

# --- the application record, which lags the rollout -------------------------
#
# SECOND HALF OF THE SAME RACE (found on the 2026-07-29 deploy). Waiting for the
# rollout to leave "progressing" is necessary but NOT sufficient: the containers
# APPLICATION record advances its `version`/`configuration.image` some time AFTER
# the rollout reports "completed". Observed live: rollout 2fd75999 completed at
# 03:34:09; the application record reached v148 / the target digest at 03:36:39 —
# 150 seconds later. Reading the application once, immediately, therefore reports
# a stale image on a perfectly healthy deploy, which is the false alarm the first
# fix was supposed to end.
#
# So the stored image is POLLED to the target with a bounded timeout, and only a
# timeout is a failure. The real incident this guards (a terminal rollout that
# genuinely leaves the application on the previous digest) still fails, just after
# the timeout instead of instantly — the difference between the two is only ever
# "does it catch up", and the only way to know is to wait.
parse_app_image_response() {
  APP_NAME="$1" python3 -c "
import sys, json, os
name = os.environ['APP_NAME']
try:
    apps = json.load(sys.stdin).get('result') or []
except Exception as e:
    print('SKIP could_not_parse_containers_response:_%s' % e); raise SystemExit
match = [a for a in apps if a.get('name') == name]
if not match:
    print('SKIP no_container_application_named_%s' % name); raise SystemExit
a = match[0]
img = ((a.get('configuration') or {}).get('image') or '').split('@')[-1]
if not img:
    print('SKIP application_missing_configuration.image'); raise SystemExit
inst = (a.get('health') or {}).get('instances') or {}
print('OK %s %s %s' % (img, a.get('version'), inst.get('failed', 0)))
"
}

# wait_for_stored_image SECRETS ACCT APP_NAME TARGET_DIGEST [TIMEOUT] [INTERVAL]
# Prints exactly one line:
#   MATCH <image> <version> <failed_instances>
#   STALE <image> <version> <failed_instances> <elapsed_secs>
#   SKIP  <message_with_no_spaces>
wait_for_stored_image() {
  local secrets="$1" acct="$2" app_name="$3" target="$4" timeout="${5:-300}" interval="${6:-15}"
  local elapsed=0 parsed img ver nfailed
  while :; do
    parsed=$(sops exec-env "$secrets" 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/'"$acct"'/containers/applications"' 2>/dev/null \
      | parse_app_image_response "$app_name" 2>/dev/null)
    [ -z "$parsed" ] && parsed="SKIP empty_or_failed_containers_api_call"

    case "$parsed" in
      SKIP*)
        echo "$parsed"
        return 0
        ;;
      *)
        set -- $parsed
        img=$2; ver=$3; nfailed=$4
        if [ "$img" = "$target" ]; then
          echo "MATCH $img $ver $nfailed"
          return 0
        fi
        if [ "$elapsed" -ge "$timeout" ]; then
          echo "STALE $img $ver $nfailed $elapsed"
          return 0
        fi
        sleep "$interval"
        elapsed=$((elapsed + interval))
        ;;
    esac
  done
}

wait_for_rollout() {
  local secrets="$1" acct="$2" app="$3" timeout="${4:-180}" interval="${5:-5}"
  local elapsed=0
  local parsed
  while :; do
    parsed=$(sops exec-env "$secrets" 'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/'"$acct"'/containers/applications/'"$app"'/rollouts"' 2>/dev/null \
      | parse_rollouts_response 2>/dev/null)
    [ -z "$parsed" ] && parsed="ERROR empty_or_failed_api_call"

    case "$parsed" in
      PROGRESSING)
        if [ "$elapsed" -ge "$timeout" ]; then
          echo "PROGRESSING $elapsed"
          return 0
        fi
        sleep "$interval"
        elapsed=$((elapsed + interval))
        ;;
      *)
        echo "$parsed"
        return 0
        ;;
    esac
  done
}
