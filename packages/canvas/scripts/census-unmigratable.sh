#!/usr/bin/env bash
# Count the shapes the canvas migration CANNOT rebuild, straight from the R2 blobs.
#
# WHY: scripts/migrate-canvas-rooms.ts refuses to run on a dump containing unmigratable
# shapes unless `--accept-loss` is passed (ADR-0019). That flag exists for a real defect
# but should never be typed against production. An earlier version of this script counted
# canvases from D1 instead of R2 and, on 2026-07-28, reported 21 canvases / 601 shapes /
# 0 dangling — while `migrate-canvas-rooms.ts dump`, which enumerates R2 blobs directly,
# found 30 canvases / 790 shapes / 3 dangling-binding arrows. Nine blobs had no matching D1
# row, including the `default` canvas (125 shapes), which held every one of the bad arrows.
# The D1-backed census's confident "0" was computed over a set that excluded every problem.
#
# The blobs are mutable. One freehand stroke drawn on any canvas invalidates that. So this
# is a PRECONDITION to re-check immediately before migrating, not a fact to cite.
#
#   If this reports non-zero, STOP. Non-zero means the world changed since the
#   measurement — it is not a cue to reach for --accept-loss. Freehand strokes cannot be
#   reconstructed from the blob (it stores flattened points; tldraw needs segments with
#   per-point pressure) and the retained blob is the only copy.
#
# Reads R2 directly, so it does NOT need the container — which matters, because the
# container was unreachable for hours on 2026-07-28 while this data stayed perfectly
# readable.
#
# Usage:  bash packages/canvas/scripts/census-unmigratable.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SECRETS=${SECRETS:-$REPO_ROOT/packages/infra/environments/production/secrets.yaml}
WORKSPACE=${WORKSPACE:-default}
BUCKET=${BUCKET:-agent-canvas}
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

echo "→ listing canvases (R2 is authoritative for WHICH blobs the migration will read)"
# Same enumeration migrate-canvas-rooms.ts's `dump` uses (listFromR2 / s3Backend in
# server/blob-store.ts): list R2 keys under the workspace's canvases prefix and derive ids
# from the ones ending in canvas-state.json. D1 rows are not consulted — a canvas can have
# a blob with no D1 row (the 2026-07-28 incident) and the migration would still read it.
CANVAS_DIR="$REPO_ROOT/packages/canvas"
LIST_SCRIPT="$OUT/list-r2-canvases.ts"
cat > "$LIST_SCRIPT" <<'TS'
const client = new Bun.S3Client({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
  endpoint: process.env.R2_ENDPOINT,
});
const prefix = `workspaces/${process.env.WORKSPACE}/canvases/`;
const res = await client.list({ prefix });
const keys = (res?.contents ?? []).map((o) => o.key);
for (const key of keys) {
  const m = /^workspaces\/[^/]+\/canvases\/([^/]+)\/canvas-state\.json$/.exec(key);
  if (m) console.log(m[1]);
}
TS
IDS=$(cd "$CANVAS_DIR" && sops exec-env "$SECRETS" "bun run $LIST_SCRIPT" 2>/dev/null)

if [ -z "$IDS" ]; then
  echo "❌ could not list canvas blobs from R2 — refusing to report a census over an unknown denominator."
  echo "   A partial census reads exactly like a clean one. Fix the listing first."
  exit 1
fi
N=$(echo "$IDS" | wc -l | tr -d ' ')
echo "   $N canvases"

echo "→ fetching blobs from R2 (no container involved — R2 stayed readable for hours on
   2026-07-28 while the container was unreachable, which is why this path is used)"
# NEWLINES MUST BECOME SPACES. `sops exec-env` runs the string through `/bin/sh -c`, and a
# newline-separated list inside `for id in ...; do` is a syntax error, not a multi-item
# loop — it fails per-item with no files written, which looks exactly like "every canvas
# is empty". Silent, and it reads as a clean census.
IDS_FLAT=$(echo "$IDS" | tr '\n' ' ')
(cd "$CANVAS_DIR" && sops exec-env "$SECRETS" "
for id in $IDS_FLAT; do
  ./node_modules/.bin/wrangler r2 object get $BUCKET/workspaces/$WORKSPACE/canvases/\$id/canvas-state.json --pipe --remote 2>/dev/null > $OUT/\$id.json || true
done") >/dev/null 2>&1

EXPECTED="$N" python3 - "$OUT" <<'PY'
import json, glob, os, sys
d = sys.argv[1]
files = sorted(glob.glob(os.path.join(d, '*.json')))
tot = {'shapes': 0, 'arrows': 0, 'draw': 0, 'bad': 0}
rows, unreadable = [], []
for f in files:
    cid = os.path.basename(f)[:-5]
    if os.path.getsize(f) == 0:
        # An empty object is a canvas with no persisted state yet — not a failure.
        rows.append((cid, 0, 0, 0, 0)); continue
    try:
        shapes = json.load(open(f)).get('shapes', [])
    except Exception as e:
        unreadable.append((cid, str(e)[:60])); continue
    ids = {s.get('id') for s in shapes}
    arrows = [s for s in shapes if s.get('type') == 'arrow']
    draw = [s for s in shapes if s.get('type') == 'draw']
    bad = [a for a in arrows if any(a.get(k) and a.get(k) not in ids for k in ('startShapeId', 'endShapeId'))]
    rows.append((cid, len(shapes), len(arrows), len(draw), len(bad)))
    for k, v in (('shapes', shapes), ('arrows', arrows), ('draw', draw), ('bad', bad)):
        tot[k] += len(v)

print(f"\n{'canvas':<42}{'shapes':>7}{'arrows':>8}{'draw':>6}{'dangling':>10}")
for r in rows:
    print(f"{r[0]:<42}{r[1]:>7}{r[2]:>8}{r[3]:>6}{r[4]:>10}")
print('-' * 73)
print(f"{'TOTAL (' + str(len(rows)) + ' canvases)':<42}{tot['shapes']:>7}{tot['arrows']:>8}{tot['draw']:>6}{tot['bad']:>10}")

expected = int(os.environ['EXPECTED'])
fail = False
if unreadable:
    print('\n❌ UNREADABLE blobs — a census with holes reads like a clean one:')
    for cid, err in unreadable:
        print(f'   {cid}: {err}')
    fail = True
if len(rows) != expected:
    print(f'\n❌ counted {len(rows)} canvases but R2 lists {expected} — incomplete census.')
    fail = True
if tot['draw'] or tot['bad']:
    print(f"\n❌ {tot['draw']} draw shape(s) and {tot['bad']} dangling-binding arrow(s) CANNOT be migrated.")
    print("   STOP. Do not pass --accept-loss. Non-zero means the canvases changed since")
    print("   they were measured; the retained blob is the only copy of a freehand stroke.")
    fail = True
raise SystemExit(1 if fail else 0)
PY

if [ $? -eq 0 ]; then
  echo
  echo "✅ nothing unmigratable — the cutover has no data-loss decision in it."
fi
