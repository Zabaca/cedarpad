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
#      wrangler.jsonc: image_build_context "../.."), so the WHOLE repo is snapshotted,
#      not just packages/canvas. node_modules (untracked, install-heavy, and already
#      stripped from the Docker build context by .dockerignore) is symlinked in from the
#      real checkout rather than reinstalled, so this stays fast.
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

echo "→ stamping build-rev $SHA"
printf '%s' "$SHA" > server/build-rev.txt

# Headless Docker config (keychain/buildx workaround — see memory cf-container-deploy-headless).
python3 -c "import json; c=json.load(open('$HOME/.docker/config.json')); c.pop('credsStore',None); c.pop('credStore',None); json.dump(c,open('$DC/config.json','w'))"
for f in cli-plugins contexts buildx; do [ -e "$HOME/.docker/$f" ] && ln -s "$HOME/.docker/$f" "$DC/$f"; done

# Shell SPA + Notebook static build (PRD #103): wrangler's `assets` binding bundles
# shell/dist (the shell at `/`, the Notebook SPA under `/notebook`), so it must exist
# before zbc runs `wrangler deploy`. The zbc cloudflare module has no build hook, so
# build it here. `bun run build` builds the shell (empties shell/dist) THEN the Notebook
# into shell/dist/notebook — order matters.
echo "→ building Shell SPA + Notebook (shell/dist)"
bun run build || { echo "❌ shell build failed"; exit 1; }

# Warehouse image (ADR-0017, #236) build check. It has no HTTP surface — no agent SDK,
# and no code path starts it yet (dispatching the materialize Job is a separate issue) —
# so the buildRev poll below, which needs a served response, can't answer "is it live"
# for this container the way it can for Sandbox. What CAN be verified without shipping
# dispatch: the image actually builds from this snapshot. `zbc apply` below builds +
# pushes BOTH images (wrangler.jsonc now declares two `containers` entries) and its exit
# code is the authoritative rollout signal — but a build failure inside that call would
# be buried in a lot of wrangler/zbc output, so build it here first, standalone, for a
# clear, fast failure before the slow zbc call even starts.
echo "→ building warehouse image standalone (no HTTP surface to poll — see comment above)"
DOCKER_CONFIG="$DC" docker build -f Dockerfile.warehouse -t agent-canvas-warehouse:deploy-check "$BUILD_ROOT" >/dev/null \
  || { echo "❌ warehouse image failed to build — aborting before rollout"; exit 1; }
echo "✅ warehouse image builds clean"

# Migrate remote Turso BEFORE the rollout. server/bridge.ts deliberately skips remote
# migrations ("remote Turso is migrated by the deploy") and edge worker routes read
# Turso directly — shipping edge code that reads a new column before the ALTER lands
# 500s the API (incident 2026-07-15, migration 0016). Drizzle's migrator is idempotent,
# so a deploy with no pending migrations is a no-op here.
echo "→ migrating remote Turso (drizzle, idempotent)"
( cd "$CANVAS_DIR" && sops exec-env "$BUILD_ROOT/packages/infra/environments/production/secrets.yaml" 'bun run webpoc:db:migrate' ) \
  || { echo "❌ remote Turso migration failed — aborting before rollout"; exit 1; }

echo "→ zbc apply production canvas (build + deploy + push secrets — both container images)"
( cd "$BUILD_ROOT" && DOCKER_CONFIG="$DC" bunx @zabaca/zbc apply production canvas ) || { echo "❌ zbc apply failed"; exit 1; }
# zbc apply's own success is the warehouse container's liveness signal (see the build
# check above for why it can't be polled): the call above builds AND pushes both images,
# so reaching this line means the warehouse image was pushed too, not just built locally.
echo "✅ LIVE (push-confirmed, no HTTP surface to poll): warehouse image pushed by zbc apply"

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
