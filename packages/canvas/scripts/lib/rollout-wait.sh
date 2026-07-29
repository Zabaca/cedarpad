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
