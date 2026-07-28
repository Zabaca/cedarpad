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

# Migrate the platform data layer BEFORE the rollout. Shipping edge code that reads a new
# column before the ALTER lands 500s the API (incident 2026-07-15, migration 0016).
#
# Since ADR-0018 / #265 the platform data layer is D1, so this applies the SAME drizzle
# migrations through wrangler instead of drizzle's own migrator against Turso. Wrangler
# tracks what it has applied in the database's own `d1_migrations` ledger, so a deploy with
# nothing pending is a no-op. Turso is deliberately NOT migrated here any more: it is frozen
# as the rollback target, and while PLATFORM_DB_ENABLED is "false" (wrangler.jsonc) that is
# also what production still reads — so a deploy carrying a NEW migration must not land
# before the cutover (#267). Migrations 0000–0025 are already applied to both.
echo "→ migrating the platform data layer on D1 (wrangler, idempotent)"
( cd "$CANVAS_DIR" && sops exec-env "$BUILD_ROOT/packages/infra/environments/production/secrets.yaml" \
    "CI=true CLOUDFLARE_ACCOUNT_ID=99a19e584439be0568f33aad0477372b ./node_modules/.bin/wrangler d1 migrations apply PLATFORM_DB --remote" ) \
  || { echo "❌ D1 migration failed — aborting before rollout"; exit 1; }

# Cutover safety net (#267). Once PLATFORM_DB_ENABLED is "true" in wrangler.jsonc, a
# deploy repoints production's reads and writes at D1. If the rows are not in D1 yet, that
# deploy is a silent data outage: every user, canvas and session vanishes from the app while
# sitting safely in Turso. The import (scripts/migrate-platform-data.ts) must land FIRST.
# So: with the flag on, refuse to roll out onto a D1 whose `user` table is empty. With the
# flag off — today, and after a rollback — this check does not run at all.
#
# This is a BACKSTOP, not the control. `bunx @zabaca/zbc apply production canvas` deploys
# without going through this script, so the guard simply does not run on that path. The
# actual control is that PLATFORM_DB_ENABLED stays "false" on main and is flipped by hand
# at cutover time, after the import has been verified.
#
# Read the flag by grep, not by parsing the .jsonc: stripping `//` comments with a regex
# also eats the `https://` inside the URL vars. -m1 takes the FIRST occurrence, which is
# the top-level (production) block — preview's redeclaration comes later in the file.
FLAG=$(grep -m1 -o '"PLATFORM_DB_ENABLED": *"[a-z]*"' "$CANVAS_DIR/wrangler.jsonc" | sed 's/.*"\([a-z]*\)"$/\1/')
if [ "$FLAG" = "true" ]; then
  echo "→ PLATFORM_DB_ENABLED=true — checking the platform D1 actually holds rows before cutting over"
  USERS=$(sops exec-env "$BUILD_ROOT/packages/infra/environments/production/secrets.yaml" \
    "CI=true CLOUDFLARE_ACCOUNT_ID=99a19e584439be0568f33aad0477372b $CANVAS_DIR/node_modules/.bin/wrangler d1 execute PLATFORM_DB --remote --json --command 'select count(*) as n from \"user\"'" \
    | python3 -c "import sys,json; s=sys.stdin.read(); print(json.loads(s[s.index('['):])[0]['results'][0]['n'])" 2>/dev/null || echo 0)
  if [ "${USERS:-0}" -lt 1 ]; then
    echo "❌ PLATFORM_DB_ENABLED is \"true\" but the platform D1 has $USERS user row(s)."
    echo "   Deploying now would cut production over to an EMPTY database."
    echo "   Import first:  bun run scripts/migrate-platform-data.ts dump | load | verify  (see #267)"
    exit 1
  fi
  echo "✅ platform D1 holds $USERS user row(s) — cutover deploy may proceed"
fi

echo "→ zbc apply production canvas (build + deploy + push secrets — both container images)"
( cd "$BUILD_ROOT" && DOCKER_CONFIG="$DC" bunx @zabaca/zbc apply production canvas ) || { echo "❌ zbc apply failed"; exit 1; }
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
echo "→ verifying the container application's STORED image matches its rollout target"
IMG_CHECK=$(sops exec-env "$BUILD_ROOT/packages/infra/environments/production/secrets.yaml" \
  'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/'"$CF_ACCOUNT"'/containers/applications"' 2>/dev/null \
  | APP_NAME="$SANDBOX_APP" python3 -c "
import sys, json, os
name = os.environ['APP_NAME']
try:
    apps = json.load(sys.stdin).get('result') or []
except Exception as e:
    print('SKIP could not parse the containers API response (%s)' % e); raise SystemExit
match = [a for a in apps if a.get('name') == name]
if not match:
    print('SKIP no container application named %s' % name); raise SystemExit
a = match[0]
img = a['configuration']['image'].split('@')[-1]
inst = a.get('health', {}).get('instances', {})
print('%s %s %s %s' % ('OK', img, a.get('version'), inst.get('failed', 0)))
" 2>/dev/null || echo "SKIP containers API call failed")

case "$IMG_CHECK" in
  SKIP*)
    # Never fail the deploy on a diagnostic that could not run — but never let it pass
    # silently either, or the check quietly stops existing.
    echo "  ⚠️  could not verify the stored image (${IMG_CHECK#SKIP }) — check by hand:"
    echo "     packages/canvas/scripts/verify-container-image.sh"
    ;;
  OK*)
    set -- $IMG_CHECK
    STORED=$2; APPVER=$3; NFAILED=$4
    TARGET=$(sops exec-env "$BUILD_ROOT/packages/infra/environments/production/secrets.yaml" \
      'curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/'"$CF_ACCOUNT"'/containers/applications/'"$SANDBOX_APP_ID"'/rollouts"' 2>/dev/null \
      | python3 -c "
import sys, json
try:
    r = (json.load(sys.stdin).get('result') or [])[0]
    print(r['target_configuration']['image'].split('@')[-1])
except Exception:
    print('?')
" 2>/dev/null || echo "?")
    if [ "$TARGET" = "?" ]; then
      echo "  ⚠️  stored image $STORED (app v$APPVER) — could not read the rollout target to compare"
    elif [ "$STORED" != "$TARGET" ]; then
      echo "❌ the container application's stored image does NOT match its rollout target."
      echo "   stored : $STORED  (app v$APPVER)"
      echo "   target : $TARGET"
      echo "   The rollout may report \"completed\" anyway. Serving instances can be correct"
      echo "   while this is wrong — the canvas will work until the first idle-sleep, then"
      echo "   every cold boot wedges on the stale image. Re-run this deploy."
      exit 1
    else
      echo "✅ stored image matches the rollout target ($STORED, app v$APPVER, failed instances: $NFAILED)"
    fi
    ;;
esac

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
