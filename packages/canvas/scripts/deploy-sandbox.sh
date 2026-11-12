#!/usr/bin/env bash
# Deploy origin/main to the workspace's sandbox on the sandbox site (sbx), the deploy target that serves the default
# workspace (ADR-0028). The Cloudflare container (deploy.sh) is not touched.
# Run from James's Mac: sbx's credentials are there (its own file, else sops), and so is what `sbx image build` reaches
# the site's builder with: `kubectl`, ssh to ryzen-9 (the tunnel to the cluster's API) and the image service's
# builder credential, kept in the operator's private repo. No incus identity is needed (the build guest is gone).
#
#   1. Archive origin/main (git archive, so the build context is exactly that commit and no repository credential goes
#      to the box) and build the image's `sandbox` form in the site's builder (packages/canvas/Dockerfile).
#      The commit and the version go in as build arguments and become the stamps inside, as deploy.sh writes
#      them (ADR-0025). The build pulls the image onto both workers and pins it.
#   2. Create the sandbox if it does not exist: its size, main port, the route, "start fresh when lost", the supervisor
#      as its start command and the supervisor's bearer as its stored environment (read from sops, never typed or
#      printed), and the supervisor's port as the only one reachable by prefix (--open-port; needs an sbx from
#      Home's slice 5 fix round on). If it exists, replace its image: same name, address, environment, command and allow-list; the pod
#      starts fresh from the new image, so the stack is down and the Worker's next request boots it on the new code.
#   3. Set its allow-list additions, and remove the ones workspace.env no longer lists (`sbx egress allow` only adds).
#   4. Fail unless the supervisor answers, the pre-bundle is there and the stamps inside are origin/main's.
#
# What the sandbox is (name, size, port, route, allow-list) is packages/canvas/sandbox/workspace.env.
#
#   bash packages/canvas/scripts/deploy-sandbox.sh [--dry-run]
#
# --dry-run resolves the commit, asks the site whether the sandbox exists and prints what it would do; it builds and
# changes nothing.
#
# Env overrides, for proving the script without touching the real sandbox (use test values only), except
# SANDBOX_DEPLOY_REF, which the release always sets:
#   SANDBOX_DEPLOY_NAME        a sandbox name other than the declared one
#   SANDBOX_DEPLOY_IMAGE_NAME  an image repository other than the declared one (so a test image is its own to delete)
#   SANDBOX_DEPLOY_REF         a git ref to build instead of origin/main (the stamp inside is then that ref's); the release
#                              skill always passes the commit it pushed, so a later merge cannot move what is deployed
#   SANDBOX_DEPLOY_SUPERVISOR_TOKEN  the supervisor's bearer, instead of reading it from sops (a TEST value: it is stored)
#   SBX                        the sbx command (default: sbx on PATH, else Home's checkout)
#
# The supervisor's bearer is stored once, at the create. A replace keeps it; rotating it means deleting the sandbox
# and running this again (and the Worker's WS_SUPERVISOR_TOKEN, which must be the same value).
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

fail() { echo "FAILED: $*" >&2; exit 1; }

REPO_ROOT=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
# shellcheck source=/dev/null
source "$REPO_ROOT/packages/canvas/sandbox/workspace.env"
NAME=${SANDBOX_DEPLOY_NAME:-$SANDBOX_NAME}
IMAGE_REPO=${SANDBOX_DEPLOY_IMAGE_NAME:-$IMAGE_NAME}
# Set but empty is refused rather than read as unset: a release passes the commit it pushed, and a variable lost between two
# shell calls would otherwise deploy whatever origin/main is by then while the stamp check still passed.
if [ "${SANDBOX_DEPLOY_REF+set}" = set ] && [ -z "$SANDBOX_DEPLOY_REF" ]; then fail "SANDBOX_DEPLOY_REF is set but empty"; fi
REF=${SANDBOX_DEPLOY_REF:-origin/main}

HOME_SBX="$HOME/Library/Application Support/Varnick/Home/packages/sandboxes/sbx"
if [ -n "${SBX:-}" ]; then :
elif command -v sbx >/dev/null 2>&1; then SBX=sbx
elif [ -x "$HOME_SBX" ]; then SBX=$HOME_SBX
else fail "no sbx: put it on PATH or set SBX (Home's packages/sandboxes/sbx)"
fi
command -v jq >/dev/null 2>&1 || fail "jq is not installed"

if [ "$REF" = origin/main ]; then
  git -C "$REPO_ROOT" fetch -q origin main || fail "could not fetch origin/main"
fi
WANT=$(git -C "$REPO_ROOT" rev-parse --short "$REF^{commit}") || fail "no such commit: $REF"
VERSION=$(git -C "$REPO_ROOT" show "$REF:package.json" | jq -er .version) || fail "could not read the version from $REF:package.json"
echo "-> deploying $REF ($WANT, v$VERSION) to sandbox $NAME"

# Does the sandbox exist? The list is captured on its own first, so that a failed `sbx list` stops the deploy (set -e)
# instead of reading as an empty list, which would look like "no such sandbox" and go on to a create.
LIST=$("$SBX" list --json) || fail "sbx list failed: cannot tell whether $NAME exists"
SANDBOX=$(jq -c --arg n "$NAME" '[.[] | select(.name == $n)] | first // empty' <<<"$LIST") || fail "could not read sbx's list"
if [ -n "$SANDBOX" ]; then EXISTS=1; else EXISTS=0; fi

# Is a sandbox the one this script makes? A replace changes only the image and keeps everything else a create set (the
# size, the port, the route, the start-fresh flag, and the list of ports reachable by prefix, which a sandbox made
# without one cannot get later). So an existing sandbox that differs in any of them is refused here, before anything is
# built or replaced: it was not made by this script. Parsed, since `sbx get` prints indented JSON.
shape_ok() {
  jq -e --argjson stack "$STACK_PORT" --argjson sup "$SUPERVISOR_PORT" --arg route "$ROUTE" \
    '.custom == true and .start_fresh == true and .port == $stack and ((.routes // []) | index($route) != null) and .ports == [$sup]' \
    >/dev/null <<<"$1"
}
if [ "$EXISTS" = 1 ] && ! shape_ok "$SANDBOX"; then
  fail "$NAME exists but is not as this script makes it (an image of its own, start fresh, port $STACK_PORT, route $ROUTE, prefixed ports [$SUPERVISOR_PORT]; see sbx get $NAME): delete it and deploy again"
fi

# shellcheck source=packages/canvas/scripts/sandbox-egress.sh
source "$REPO_ROOT/packages/canvas/scripts/sandbox-egress.sh"

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: would build $IMAGE_REPO from $REF ($DOCKERFILE, IMAGE_KIND=sandbox, BUILD_REV=$WANT, BUILD_VERSION=$VERSION)"
  if [ "$EXISTS" = 1 ]; then echo "dry run: $NAME exists: would replace its image"; else echo "dry run: $NAME does not exist: would create it"; fi
  echo "dry run: would allow $EGRESS_ALLOW and check the stamps are $WANT / $VERSION"
  if [ "$EXISTS" = 1 ]; then
    DRY_NOW=$("$SBX" egress "$NAME") || fail "sbx egress $NAME failed: cannot tell what it may reach"
    DRY_STALE=$(stale_egress "$EGRESS_ALLOW" <<<"$DRY_NOW")
    if [ -n "$DRY_STALE" ]; then echo "dry run: would remove the allow-list additions workspace.env no longer lists: $(tr '\n' ' ' <<<"$DRY_STALE")"; else echo "dry run: no allow-list additions to remove"; fi
  fi
  exit 0
fi

# The bearer, for a create only (a replace keeps the stored one): from SANDBOX_DEPLOY_SUPERVISOR_TOKEN (a test value),
# else cedarpad's production secrets, the same value the Worker holds. A WS_SUPERVISOR_TOKEN that happens to be in this
# shell is never used, so a stray real value cannot become the stored bearer by accident. Exported, because
# `sbx create --env KEY` takes the value from the environment and so it is on no command line.
unset WS_SUPERVISOR_TOKEN
if [ "$EXISTS" = 0 ]; then
  if [ -n "${SANDBOX_DEPLOY_SUPERVISOR_TOKEN:-}" ]; then
    WS_SUPERVISOR_TOKEN=$SANDBOX_DEPLOY_SUPERVISOR_TOKEN
  else
    WS_SUPERVISOR_TOKEN=$(sops -d --extract '["WS_SUPERVISOR_TOKEN"]' "$REPO_ROOT/packages/infra/environments/production/secrets.yaml") \
      || fail "could not read WS_SUPERVISOR_TOKEN from production/secrets.yaml (sops, this Mac's age key)"
  fi
  export WS_SUPERVISOR_TOKEN
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "-> archiving $REF"
git -C "$REPO_ROOT" archive --format=tar.gz -o "$TMP/context.tgz" "$REF"

echo "-> building $IMAGE_REPO in the site's builder (about 4 minutes from nothing; it scales the builder pod up and back to zero)"
IMAGE=$("$SBX" image build "$TMP/context.tgz" --name "$IMAGE_REPO" --dockerfile "$DOCKERFILE" \
  --build-arg IMAGE_KIND=sandbox --build-arg "BUILD_REV=$WANT" --build-arg "BUILD_VERSION=$VERSION" | tail -1)
case "$IMAGE" in
  *@sha256:*) echo "   image $IMAGE" ;;
  *) fail "the build did not print an image reference by digest (got: $IMAGE)" ;;
esac

if [ "$EXISTS" = 1 ]; then
  echo "-> replacing the image of $NAME"
  "$SBX" replace "$NAME" --image "$IMAGE"
else
  echo "-> creating $NAME"
  # --open-port: the ports reachable at <port>-<name>. sbx's router would otherwise reach any port of the sandbox
  # by prefix (the bridge's, sandboxd's neighbours); with a list it refuses every other. Only the supervisor's.
  "$SBX" create "$NAME" --image "$IMAGE" \
    --mem-request "$MEM_REQUEST" --mem-limit "$MEM_LIMIT" --cpu-request "$CPU_REQUEST" --cpu-limit "$CPU_LIMIT" \
    --port "$STACK_PORT" --open-port "$SUPERVISOR_PORT" --start-fresh --route "$ROUTE" \
    --env WS_SUPERVISOR_TOKEN \
    --env "WS_CANVAS_CWD=$CANVAS_CWD" --env "WS_SUPERVISOR_PORT=$SUPERVISOR_PORT" --env "WS_VITE_PORT=$STACK_PORT" \
    --env "NODE_EXTRA_CA_CERTS=$CA_CERT" \
    --cmd "cd $CANVAS_CWD && exec bun run scripts/ws-supervisor.ts"
fi

# And after the create or replace: the sandbox is as declared (the same check as before the replace).
shape_ok "$("$SBX" get "$NAME")" || fail "$NAME is not as declared after the deploy (see sbx get $NAME)"

echo "-> allow-list: $EGRESS_ALLOW"
# shellcheck disable=SC2086  # a space-separated list of hosts
"$SBX" egress "$NAME" allow $EGRESS_ALLOW >/dev/null
# `allow` only adds, so a host removed from workspace.env would stay reachable on a sandbox that already exists:
# take away the sandbox's own additions the declaration no longer lists (sandbox/workspace.env is the whole
# truth, and the site-wide list is never touched). The listing is captured first so a failed `sbx egress` stops
# the deploy (set -e) instead of reading as "nothing stale".
EGRESS_NOW=$("$SBX" egress "$NAME") || fail "sbx egress $NAME failed: cannot tell what it may reach"
STALE_EGRESS=$(stale_egress "$EGRESS_ALLOW" <<<"$EGRESS_NOW")
if [ -n "$STALE_EGRESS" ]; then
  echo "-> removing allow-list additions workspace.env no longer lists: $(tr '\n' ' ' <<<"$STALE_EGRESS")"
  # shellcheck disable=SC2086  # one host per line
  "$SBX" egress "$NAME" remove $STALE_EGRESS >/dev/null
  EGRESS_AFTER=$("$SBX" egress "$NAME") || fail "sbx egress $NAME failed after the removal: cannot tell what it may reach"
  [ -z "$(stale_egress "$EGRESS_ALLOW" <<<"$EGRESS_AFTER")" ] || fail "$NAME may still reach hosts workspace.env does not list (see sbx egress $NAME)"
fi

# The supervisor is the start command: answering means the command ran with its stored environment (it refuses to
# start without the bearer). The stack stays down until the Worker pushes its environment.
echo "-> waiting for the supervisor on :$SUPERVISOR_PORT"
UP=
for _ in $(seq 1 30); do
  if "$SBX" exec "$NAME" bun -e "const r = await fetch('http://127.0.0.1:$SUPERVISOR_PORT/__status'); process.exit(r.ok ? 0 : 1)" >/dev/null 2>&1; then
    UP=1
    break
  fi
  sleep 1
done
[ -n "$UP" ] || fail "the supervisor did not answer on :$SUPERVISOR_PORT within 30 s"

"$SBX" exec "$NAME" test -f "$CANVAS_CWD/node_modules/.vite/deps/_metadata.json" || fail "$NAME has no vite pre-bundle"

GOT=$("$SBX" exec "$NAME" cat "$CANVAS_CWD/server/build-rev.txt")
GOT_VERSION=$("$SBX" exec "$NAME" cat "$CANVAS_CWD/server/version.txt")
if [ "$GOT" != "$WANT" ] || [ "$GOT_VERSION" != "$VERSION" ]; then
  fail "$NAME is stamped $GOT / v$GOT_VERSION, expected $WANT / v$VERSION"
fi
echo "ok: $NAME is on $GOT (v$GOT_VERSION); the next request to the workspace boots the stack on it"
