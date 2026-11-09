#!/usr/bin/env bash
# Verified deploy of agent-canvas to Cloudflare. It stamps the current git SHA into the
# image, migrates D1, deploys via zbc (`bun run apply production canvas`: shell build,
# wrangler deploy — Worker + container image — and secrets), then, when the default
# workspace runs on Cloudflare, POLLS the public /api/buildrev until the SERVED buildRev
# equals the SHA we shipped.
#
# There are no container rollouts to wait for: the workspace container runs on the
# `durable_object` scheduling policy (worker/canvas-container.ts), so the image ships with
# the Worker version and each container takes it on its next request (the DO's boot
# fingerprint). That is why the 408 retry, the rollout settle and the stored-image check
# this script used to carry are gone.
#
#   bash packages/canvas/scripts/deploy.sh
# Env overrides: CANVAS_URL (default https://app.cedarpad.com), POLL_TRIES (default 60).
#
# CONCURRENT-EDIT SAFETY (incident: a deploy ran in the background while a rebase was
# happening in the same checkout; the image baked mid-rebase conflict markers from
# server/bridge.ts and the container crashed on boot). Two layers:
#   1. Dirty tree is a HARD FAILURE by default (git status --porcelain non-empty), not
#      just a warning. DEPLOY_ALLOW_DIRTY=1 restores the old warn-and-proceed behavior
#      for an intentional "ship my uncommitted edits" deploy.
#   2. On a clean tree, the whole build + deploy runs from a `git worktree` snapshot of
#      HEAD, not the live checkout — so any edit (rebase, stray save) to the real
#      checkout made *while the build is running* cannot leak into the image. The
#      container's Dockerfile build context is the repo root (packages/canvas/
#      wrangler.jsonc: build_context "../.."), so the WHOLE repo is snapshotted,
#      not just packages/canvas. node_modules (untracked, install-heavy, and already
#      stripped from the Docker build context by .dockerignore) is symlinked in from the
#      real checkout rather than reinstalled, so this stays fast.
#
# After a deploy that REMOVES a custom domain from wrangler.jsonc, check the Workers
# domains API: `wrangler deploy` does not detach a domain that is no longer declared.
#   GET/DELETE https://api.cloudflare.com/client/v4/accounts/<account>/workers/domains
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)          # packages/canvas (absolute)
REPO_ROOT=$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)
SHA=$(cd "$REPO_ROOT" && git rev-parse --short HEAD)
URL=${CANVAS_URL:-https://app.cedarpad.com}
TRIES=${POLL_TRIES:-60}
CANVAS_REL=$(cd "$SCRIPT_DIR" && git rev-parse --show-prefix | sed 's:/*$::')  # e.g. packages/canvas

DC=$(mktemp -d)
SNAPSHOT=""
cleanup() {
  rm -rf "$DC"
  if [ -n "$SNAPSHOT" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$SNAPSHOT" 2>/dev/null
    rm -rf "$SNAPSHOT"
  fi
}
trap cleanup EXIT

# HEAD must be published. A deploy stamps the local SHA into buildRev, so deploying an
# unpushed commit produces a prod that serves code no one else can see — and, worse, invites
# schema drift: on 2026-07-25 prod was serving 0154aa4, a commit that only existed on one
# laptop, and its migration had reached remote Turso with no matching commit on origin. The
# ledger repair that cost is exactly what this check buys. Ancestor-of (not equal-to) so a
# deliberate rollback to an older PUSHED commit still works.
echo "→ checking HEAD is published to origin/main (unpushed code in prod is how the migration ledger drifted)"
git -C "$REPO_ROOT" fetch -q origin main 2>/dev/null || echo "  ⚠️  could not fetch origin/main — comparing against the last known ref"
if ! git -C "$REPO_ROOT" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  if [ "${DEPLOY_ALLOW_UNPUSHED:-}" = "1" ]; then
    echo "  ⚠️  HEAD ($SHA) is not on origin/main — DEPLOY_ALLOW_UNPUSHED=1 set, shipping it anyway"
  else
    echo "❌ HEAD ($SHA) is not an ancestor of origin/main — refusing to deploy."
    echo "   Push it first (git push origin main), or set DEPLOY_ALLOW_UNPUSHED=1 to ship an unpublished commit."
    git -C "$REPO_ROOT" log --oneline origin/main..HEAD | sed 's/^/   unpushed: /'
    exit 1
  fi
fi

echo "→ checking working tree is clean (dirty tree can leak uncommitted/mid-edit code into the image)"
DIRTY=$(git -C "$REPO_ROOT" status --porcelain)
BUILD_ROOT="$REPO_ROOT"
if [ -n "$DIRTY" ]; then
  if [ "${DEPLOY_ALLOW_DIRTY:-}" = "1" ]; then
    echo "  ⚠️  working tree dirty — DEPLOY_ALLOW_DIRTY=1 set, deploying the live checkout as-is (buildRev reflects HEAD, not your uncommitted edits)"
  else
    echo "❌ working tree is dirty — refusing to deploy (a concurrent edit mid-build is exactly how prod broke last time)."
    echo "   Commit/stash your changes, or set DEPLOY_ALLOW_DIRTY=1 to deploy the live checkout anyway."
    echo "$DIRTY"
    exit 1
  fi
else
  echo "→ tree is clean — building from an immutable snapshot of HEAD so a mid-build edit can't leak in"
  SNAPSHOT=$(mktemp -d)
  rmdir "$SNAPSHOT"
  git -C "$REPO_ROOT" worktree add --detach "$SNAPSHOT" HEAD >/dev/null
  # node_modules is untracked (git worktree add won't bring it) and is stripped from the
  # Docker build context by .dockerignore anyway — symlink it in from the real checkout
  # so host-side steps (bun run build, wrangler) don't need a fresh install.
  while IFS= read -r nm; do
    rel=${nm#"$REPO_ROOT"/}
    mkdir -p "$SNAPSHOT/$(dirname "$rel")"
    ln -s "$nm" "$SNAPSHOT/$rel"
  done < <(find "$REPO_ROOT" -maxdepth 3 -name node_modules -not -path '*/node_modules/*')
  BUILD_ROOT="$SNAPSHOT"
fi

CANVAS_DIR="$BUILD_ROOT/$CANVAS_REL"
cd "$CANVAS_DIR"

# Two stamps, two questions (ADR-0025). The SHA is the operational truth — precise to the
# commit, and what identifies a build when someone reports a bug. The version is the
# communication truth: what a tag claims went live, and what the app and the changelog say.
# The version is read from the ROOT package.json, not packages/canvas's: a release ships one
# Cloudflare instance, so it carries one product version, and the per-package 0.0.1s stay
# private and unbumped.
VERSION=$(python3 -c "import json; print(json.load(open('$BUILD_ROOT/package.json'))['version'])" 2>/dev/null) || {
  echo "❌ could not read version from $BUILD_ROOT/package.json"; exit 1; }
echo "→ stamping build-rev $SHA, version $VERSION"
printf '%s' "$SHA" > server/build-rev.txt
printf '%s' "$VERSION" > server/version.txt

# Headless Docker config (keychain/buildx workaround — see memory cf-container-deploy-headless).
python3 -c "import json; c=json.load(open('$HOME/.docker/config.json')); c.pop('credsStore',None); c.pop('credStore',None); json.dump(c,open('$DC/config.json','w'))"
for f in cli-plugins contexts buildx; do [ -e "$HOME/.docker/$f" ] && ln -s "$HOME/.docker/$f" "$DC/$f"; done

# Migrate the platform data layer BEFORE the deploy. Shipping edge code that reads a new
# column before the ALTER lands 500s the API (incident 2026-07-15, migration 0016).
#
# Since ADR-0018 / #265 the platform data layer is D1, so this applies the SAME drizzle
# migrations through wrangler instead of drizzle's own migrator. Wrangler tracks what it
# has applied in the database's own `d1_migrations` ledger, so a deploy with nothing
# pending is a no-op. The Turso rollback path (the cutover safety net that used to gate
# here) was retired in #268 — D1 is the only store now.
echo "→ migrating the platform data layer on D1 (wrangler, idempotent)"
( cd "$CANVAS_DIR" && sops exec-env "$BUILD_ROOT/packages/infra/environments/production/secrets.yaml" \
    "CI=true CLOUDFLARE_ACCOUNT_ID=99a19e584439be0568f33aad0477372b ./node_modules/.bin/wrangler d1 migrations apply PLATFORM_DB --remote" ) \
  || { echo "❌ D1 migration failed — aborting before the deploy"; exit 1; }

# `bun run apply`, never a bare `bunx @zabaca/zbc`. Unpinned, that resolves to whatever
# is latest at the moment of the release, against a vendor/zbc subtree pinned to a tag —
# so the engine converging production was decided by the clock. `bun run apply` uses the
# version the root package.json pins, and runs check-zbc-pin.ts first, which refuses when
# that version and the vendored tag disagree. The snapshot symlinks node_modules in
# (see above), so `zbc` resolves here exactly as it does in the live checkout. The zbc
# instance builds the Shell SPA (shell/dist) itself before deploying.
echo "→ bun run apply production canvas (shell build + Worker + container image + secrets)"
( cd "$BUILD_ROOT" && DOCKER_CONFIG="$DC" bun run apply production canvas ) || { echo "❌ apply failed"; exit 1; }

# Verify against the public /api/buildrev (#74): the ONE public path (only the SHA and
# version, no health/client fields), answered by wherever the default workspace's stack
# runs. When `default` is self-hosted (SELF_HOSTED_WORKSPACES in wrangler.jsonc), that is
# the VM or the sandbox, which `bun run deploy:vm` or `bun run deploy:sandbox` ships and verifies,
# so there is nothing on Cloudflare for this poll to prove, and it is skipped rather than
# compared against the self-hosted SHA.
# BOTH stamps must match (ADR-0025). Checking only the SHA would let a release ship with a
# stale or missing version.txt and still report success — and the tag written after this
# check is a claim about the VERSION, so the version is exactly what has to be proven.
if grep -q '"SELF_HOSTED_WORKSPACES": *"{[^"]*\\"default\\"' wrangler.jsonc; then
  echo "✅ deployed v$VERSION ($SHA). The default workspace is self-hosted, so /api/buildrev reports"
  echo "   the VM or the sandbox: ship and verify that with \`bun run deploy:vm\` or \`bun run deploy:sandbox\`. Cloudflare containers take the"
  echo "   new image on their next request."
  exit 0
fi
WANT="$SHA $VERSION"
echo "→ verifying served buildRev+version == $WANT (cold boot; up to $((TRIES*5))s)"
cur="? ?"
for i in $(seq 1 "$TRIES"); do
  cur=$(curl -s --max-time 20 "$URL/api/buildrev" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('buildRev','?'), d.get('version','?'))" 2>/dev/null || echo "? ?")
  if [ "$cur" = "$WANT" ]; then echo "✅ LIVE: v$VERSION ($SHA) is serving at $URL"; exit 0; fi
  printf '   [%02d/%s] served=%s expected=%s\n' "$i" "$TRIES" "$cur" "$WANT"
  sleep 5
done
echo "❌ TIMEOUT: served=$cur expected=$WANT — the new code is NOT confirmed live"
exit 1
