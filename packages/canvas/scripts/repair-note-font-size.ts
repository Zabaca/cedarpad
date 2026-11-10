// Repair the notes the 2026-07-28 cutover rendered invisible.
//
// THE BUG: `worker/blob-to-snapshot.ts` migrated every note with `fontSizeAdjustment: 0`.
// tldraw draws a note's label at `(fontSizeAdjustment ?? 1) * labelFontSize`, and `0 ?? 1`
// is 0 — nullish coalescing does not catch 0 — so every migrated sticky note renders its
// text at 0px. The text is intact in the record; it is drawn at zero size.
//
// WHY A SCRIPT AND NOT A REDEPLOY: the wrong value is baked into records already in the
// rooms. Fixing the default (this PR) only helps notes created from now on.
//
// WHY NOT `load --force` FROM THE CUTOVER DUMP: that would restore the pre-cutover
// snapshot and DISCARD everything drawn since. This is a read-modify-write of the LIVE
// room: read the current snapshot, rewrite one field on note records, write it back. Every
// other record, and every edit made since the cutover, passes through untouched.
//
// SAFETY:
//   - Dry run by DEFAULT. `--apply` is required to write anything.
//   - Per canvas: reads, patches, and re-reads to confirm the patch took.
//   - Only note records are touched, and only their `fontSizeAdjustment`. A note that
//     already has a non-zero value is left alone (someone edited it; tldraw recomputed it).
//   - A canvas with nothing to fix is skipped without a write.
//   - RACE: this replaces a whole room. A client editing that canvas mid-write can lose
//     the edit it had in flight. Run it when the boards are idle.
//
// Usage:
//   sops exec-env packages/infra/environments/production/secrets.yaml \
//     "bun run scripts/repair-note-font-size.ts --target https://app.cedarpad.com"
//   ... then the same with --apply once the dry run reads correctly.
import type { RoomSnapshot } from '@tldraw/sync-core';

import { CANVAS_SNAPSHOT_LABEL, canvasOperatorToken } from '../shared/canvas-operator-token.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const target = opt('target') ?? 'https://app.cedarpad.com';
const apply = flag('apply');
const only = opt('canvas');
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  console.error('❌ BETTER_AUTH_SECRET is not set. Run under `sops exec-env <secrets.yaml>`.');
  process.exit(1);
}

const auth = async (canvas: string) => ({
  authorization: `Bearer ${await canvasOperatorToken(secret, CANVAS_SNAPSHOT_LABEL, canvas)}`,
});

/** Canvas ids from R2 — the same enumeration the migration used. R2 is authoritative for
 *  which canvases exist as far as this data is concerned; the D1 `canvases` table misses
 *  some (that mistake is what made the pre-cutover census report a clean zero). */
async function listCanvases(): Promise<string[]> {
  const client = new Bun.S3Client({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    endpoint: process.env.R2_ENDPOINT,
  });
  const workspace = process.env.WORKSPACE ?? 'default';
  const res = await client.list({ prefix: `workspaces/${workspace}/canvases/` });
  const ids: string[] = [];
  for (const o of res?.contents ?? []) {
    const m = /^workspaces\/[^/]+\/canvases\/([^/]+)\/canvas-state\.json$/.exec(o.key ?? '');
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

type Doc = { state: { typeName?: string; type?: string; props?: Record<string, unknown> } };

/** Rewrite note records whose multiplier is 0 (or missing). Returns how many changed. */
function patch(snapshot: RoomSnapshot): number {
  let changed = 0;
  for (const doc of snapshot.documents as unknown as Doc[]) {
    const s = doc.state;
    if (s?.typeName !== 'shape' || s.type !== 'note' || !s.props) continue;
    const current = s.props.fontSizeAdjustment;
    // Only the broken value. A note someone has since edited carries tldraw's recomputed
    // size and must keep it.
    if (typeof current === 'number' && current > 0) continue;
    s.props.fontSizeAdjustment = 1;
    changed += 1;
  }
  return changed;
}

const notesAtZero = (snapshot: RoomSnapshot): number =>
  (snapshot.documents as unknown as Doc[]).filter(
    (d) => d.state?.type === 'note' && !((d.state.props?.fontSizeAdjustment as number) > 0),
  ).length;

const canvases = only ? [only] : await listCanvases();
console.log(`→ ${apply ? 'REPAIRING' : 'DRY RUN over'} ${canvases.length} canvas(es) at ${target}`);
if (!apply) console.log('  (nothing will be written — pass --apply to write)\n');

let totalFixed = 0;
let failed = 0;

for (const canvas of canvases) {
  const headers = await auth(canvas);
  const res = await fetch(`${target}/api/canvas-sync/${canvas}/snapshot`, { headers });
  if (!res.ok) {
    console.log(`${canvas.padEnd(44)} ✗ read ${res.status}`);
    failed += 1;
    continue;
  }
  const snapshot = (await res.json()) as RoomSnapshot;
  const broken = notesAtZero(snapshot);
  if (broken === 0) {
    console.log(`${canvas.padEnd(44)} — nothing to fix`);
    continue;
  }

  if (!apply) {
    console.log(`${canvas.padEnd(44)} would fix ${broken} note(s)`);
    totalFixed += broken;
    continue;
  }

  const changed = patch(snapshot);
  const put = await fetch(`${target}/api/canvas-sync/${canvas}/snapshot?force=1`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  if (!put.ok) {
    console.log(`${canvas.padEnd(44)} ✗ write ${put.status} (${(await put.text()).slice(0, 120)})`);
    failed += 1;
    continue;
  }

  // Re-read: a 200 means the write was accepted, not that the room holds what we sent.
  const after = await fetch(`${target}/api/canvas-sync/${canvas}/snapshot`, { headers });
  const remaining = after.ok ? notesAtZero((await after.json()) as RoomSnapshot) : -1;
  if (remaining !== 0) {
    console.log(`${canvas.padEnd(44)} ✗ verify: ${remaining} note(s) still at 0`);
    failed += 1;
    continue;
  }
  console.log(`${canvas.padEnd(44)} ✓ fixed ${changed} note(s)`);
  totalFixed += changed;
}

console.log(
  `\n${apply ? 'Repaired' : 'Would repair'} ${totalFixed} note(s) across ${canvases.length} canvas(es).` +
    (failed ? ` ${failed} canvas(es) FAILED — see above.` : ''),
);
process.exit(failed ? 1 : 0);
