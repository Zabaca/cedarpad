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

# Cloudflare coordinates for the post-deploy container check (incident 2026-07-28, below).
# The account id is already assumed inline by the D1 guard further down; named here so both
# uses move together. The app name is DERIVED from the worker name + the DO class rather
# than hardcoded — Cloudflare names a container application "<worker>-<class>", so a worker
# rename must not silently turn this check into a no-op via a name that matches nothing.
CF_ACCOUNT=${CLOUDFLARE_ACCOUNT_ID:-99a19e584439be0568f33aad0477372b}
SANDBOX_APP=${SANDBOX_APP:-$(grep -m1 -o '"name": *"[a-z0-9-]*"' "$SCRIPT_DIR/wrangler.jsonc" | sed 's/.*"\([a-z0-9-]*\)"$/\1/')-sandbox}
SANDBOX_APP_ID=${SANDBOX_APP_ID:-a03ba78e-7285-4761-b91d-ba494056087c}
WAREHOUSE_APP=${WAREHOUSE_APP:-${SANDBOX_APP%-sandbox}-warehouse}
WAREHOUSE_APP_ID=${WAREHOUSE_APP_ID:-a0313006-6af9-4e63-b1d9-397c2cc21ba9}

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

# Migrate the platform data layer BEFORE the rollout. Shipping edge code that reads a new
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
  || { echo "❌ D1 migration failed — aborting before rollout"; exit 1; }

# `bun run apply`, never a bare `bunx @zabaca/zbc`. Unpinned, that resolves to whatever
# is latest at the moment of the release, against a vendor/zbc subtree pinned to a tag —
# so the engine converging production was decided by the clock. `bun run apply` uses the
# version the root package.json pins, and runs check-zbc-pin.ts first, which refuses when
# that version and the vendored tag disagree. The snapshot symlinks node_modules in
# (see above), so `zbc` resolves here exactly as it does in the live checkout.
#
# RETRIED, but only for one failure (2026-09-24, v0.4.1). A container-application PATCH that
# CHANGES the image takes Cloudflare 15-25+s to answer, and its gateway cuts every request
# at exactly 25s with 408 {"error":"Request timeout"} — measured: 17.4s -> 200, 25s -> 408,
# and a no-op PATCH (same image) 3.4s. wrangler does not retry it, and by then the Worker is
# already deployed, so every lost race left a new Worker in front of an old container. A 408
# modify commits nothing (updated_at moves; version, image and rollouts do not), so trying
# again is safe — EXCEPT that an app wrangler DID update in the same run has a rollout in
# flight whose app record still shows the old image, and a re-run would re-modify it and
# REPLACE that rollout (the v146 trap, below). So every container app is settled — rollout
# out of `progressing`, stored image at its target — before each retry, and any other
# failure still exits on the first attempt.
SECRETS_FILE="$BUILD_ROOT/packages/infra/environments/production/secrets.yaml"
source "$SCRIPT_DIR/scripts/lib/rollout-wait.sh"

settle_containers() {
  local id name r
  for pair in "$SANDBOX_APP_ID:$SANDBOX_APP" "$WAREHOUSE_APP_ID:$WAREHOUSE_APP"; do
    id=${pair%%:*}; name=${pair#*:}
    r=$(wait_for_rollout "$SECRETS_FILE" "$CF_ACCOUNT" "$id" "${ROLLOUT_WAIT_TIMEOUT:-600}" 5)
    case "$r" in
      DONE*)
        set -- $r
        r=$(wait_for_stored_image "$SECRETS_FILE" "$CF_ACCOUNT" "$name" "$4" "${STORED_IMAGE_WAIT_TIMEOUT:-300}" 15)
        case "$r" in
          MATCH*) echo "  $name settled ($r)" ;;
          *) echo "  ⚠️  $name: stored image not confirmed at its rollout target ($r)"; return 1 ;;
        esac
        ;;
      *) echo "  ⚠️  $name: rollout not settled ($r)"; return 1 ;;
    esac
  done
}

APPLY_ATTEMPTS=${APPLY_ATTEMPTS:-4}
echo "→ bun run apply production canvas (build + deploy + push secrets — both container images)"
for attempt in $(seq 1 "$APPLY_ATTEMPTS"); do
  ( cd "$BUILD_ROOT" && DOCKER_CONFIG="$DC" bun run apply production canvas ) 2>&1 | tee "$DC/apply.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] && break
  if ! grep -q 'Error modifying application' "$DC/apply.log" || ! grep -q 'Request timeout' "$DC/apply.log"; then
    echo "❌ apply failed"; exit 1
  fi
  if [ "$attempt" -ge "$APPLY_ATTEMPTS" ]; then
    echo "❌ apply failed: Cloudflare timed out a container update on all $APPLY_ATTEMPTS attempts"; exit 1
  fi
  echo "⚠️  Cloudflare timed out a container update (attempt $attempt/$APPLY_ATTEMPTS) — settling every container app, then retrying"
  settle_containers || { echo "❌ a container app did not settle — not retrying over it; check by hand: packages/canvas/scripts/verify-container-image.sh"; exit 1; }
done
# zbc apply's own success confirms the warehouse image was PUSHED (the call above builds
# AND pushes both images, so reaching this line means it got further than the local build
# check). That is NOT the same claim as LIVE — nothing starts or polls the warehouse
# container (no dispatch path yet, see #240), so there is no served response to confirm
# against. Say exactly what was verified, not more: pushed, not live.
echo "✅ warehouse image built + pushed (not started — no dispatch path yet, see #240)"

# --- the container application's PERSISTED image (incident 2026-07-28) -----------------
#
# The buildRev poll below reaches a live container and proves the SERVING instances carry
# the new SHA. It does NOT prove the container application's stored configuration was
# updated — and those are two different facts.
#
# On 2026-07-28 the D1-cutover deploy passed the buildRev poll: the rollout started new
# instances on the new image and they answered correctly. But the application record kept
# `configuration.image` at the PREVIOUS digest while its rollout reported "completed"
# (from f654fd34…, to c223533d…, app stayed f654fd34…). Serving instances were right; the
# configuration every FUTURE cold boot reads was not.
#
# That is invisible while an instance stays warm. The canvas worked for ~15 minutes. Then
# the idle reaper (STALE_MS, server/bridge.ts) exited the process as designed, the next
# request cold-booted the OLD image against the NEW worker env — which by then no longer
# forwarded TURSO_URL/TURSO_KEY (ADR-0018 #266, worker/container-env.ts) — and every
# container-bound request hung. `/__bootlog` hung too: it calls getProcessLogs on the
# Sandbox DO, which was itself waiting on a container that never finished booting.
#
# So: assert the stored image equals the rollout's target. This is the check that would
# have caught it at deploy time, when buildRev could not.
#
# BUT (issue #342): version/configuration.image only advance when the rollout COMPLETES,
# so reading them immediately after `zbc apply` races a still-`progressing` rollout —
# observed live: scheduling: 3 -> starting: 3 -> healthy: 2, starting: 1 -> healthy: 3,
# and only then did version/image flip. That false failure used to say "Re-run this
# deploy" — re-running REPLACES the healthy in-flight rollout (v146 -> "replaced",
# superseded by v147). So wait for the newest rollout to leave "progressing" first, and
# never suggest a re-run while one is still in flight.
echo "→ waiting for the container rollout to settle before checking the stored image (issue #342)"
ROLLOUT=$(wait_for_rollout "$SECRETS_FILE" "$CF_ACCOUNT" "$SANDBOX_APP_ID" "${ROLLOUT_WAIT_TIMEOUT:-180}" 5)

case "$ROLLOUT" in
  ERROR*)
    # Never fail the deploy on a diagnostic that could not run — but never let it pass
    # silently either, or the check quietly stops existing.
    echo "  ⚠️  could not read rollout status (${ROLLOUT#ERROR }) — check by hand:"
    echo "     packages/canvas/scripts/verify-container-image.sh"
    ;;
  PROGRESSING*)
    set -- $ROLLOUT
    ELAPSED=$2
    echo "  ⚠️  rollout still progressing after ${ELAPSED}s — this is NOT a failure, it just"
    echo "     has not finished yet. Do NOT re-run this deploy: re-running replaces an"
    echo "     in-flight rollout with a new one (that is exactly how v146 became 'replaced')."
    echo "     Give it more time, then check by hand:"
    echo "     packages/canvas/scripts/verify-container-image.sh"
    ;;
  DONE*)
    set -- $ROLLOUT
    RSTATUS=$2; RTARGET=$4
    # The application record lags the rollout — up to ~150s observed — so this POLLS it
    # to the target rather than reading it once. Reading once is what produced the
    # 2026-07-29 false alarm on a deploy that was entirely healthy.
    echo "→ rollout reached '$RSTATUS' — waiting for the application's STORED image to reach the target"
    IMG_CHECK=$(wait_for_stored_image "$SECRETS_FILE" "$CF_ACCOUNT" "$SANDBOX_APP" "$RTARGET" \
      "${STORED_IMAGE_WAIT_TIMEOUT:-300}" 15)

    case "$IMG_CHECK" in
      SKIP*)
        echo "  ⚠️  could not verify the stored image (${IMG_CHECK#SKIP }) — check by hand:"
        echo "     packages/canvas/scripts/verify-container-image.sh"
        ;;
      STALE*)
        set -- $IMG_CHECK
        STORED=$2; APPVER=$3; NFAILED=$4; WAITED=$5
        echo "❌ rollout reached '$RSTATUS', but after ${WAITED}s the application's stored image still"
        echo "   does not match its rollout target."
        echo "   stored : $STORED  (app v$APPVER)"
        echo "   target : $RTARGET"
        echo "   This is the 2026-07-28 incident this check exists for: a rollout can report a"
        echo "   terminal status while configuration.image stays on the previous digest. Serving"
        echo "   instances can be correct while this is wrong — the canvas works until the first"
        echo "   idle-sleep, then every cold boot wedges on the stale image."
        echo "   The two settle races are already waited out (rollout status, then this poll), so"
        echo "   this is not a timing artefact — investigate by hand, do not blindly re-run:"
        echo "     packages/canvas/scripts/verify-container-image.sh"
        exit 1
        ;;
      MATCH*)
        set -- $IMG_CHECK
        echo "✅ stored image matches the rollout target ($2, app v$3, failed instances: $4)"
        ;;
    esac
    ;;
esac

# Verify against the public /api/buildrev (#74). Post-#47 the edge Better Auth gate is
# the sole gate, so /api/status and /__recycle serve the login page to an unauthenticated
# script. /api/buildrev is the ONE public path (only the SHA, no health/client fields) and
# reaches the container ahead of the gate, so the verify loop needs no session/secret. The
# explicit /__recycle kick is gone: `zbc apply` above rolls the container onto the new
# image immediately, so polling the served SHA alone confirms the rollout.
# BOTH stamps must match (ADR-0025). Checking only the SHA would let a release ship with a
# stale or missing version.txt and still report success — and the tag written after this
# check is a claim about the VERSION, so the version is exactly what has to be proven.
WANT="$SHA $VERSION"
echo "→ verifying served buildRev+version == $WANT (cold boot + rollout settle; up to $((TRIES*5))s)"
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
