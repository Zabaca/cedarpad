// READ-ONLY census: which BUILT-IN (base-tier) Components nothing is rendering.
//
// The base tier is 74 `.tsx` files in `src/canvas-components/`, bundled into the image via
// `base-manifest.generated.ts`. Unlike own- and shared-tier Components they are not
// workspace Records, so the Components stage cannot delete one — removing it is a commit
// (delete the file, regenerate the manifest) plus a deploy. This produces the list of
// candidates: a base Component with no card anywhere is a file nobody's canvas renders.
//
// DELIBERATELY CONSERVATIVE. It counts cards by MODULE NAME, ignoring tier resolution, so a
// canvas that shadows `Dashboard` with its own copy still counts as a `Dashboard` sighting.
// That over-counts usage and under-reports deletion candidates — the safe direction. A name
// reported here as unused is unused under any resolution.
//
// Writes NOTHING. No --apply, no POST.
//
// Usage:
//   sops exec-env packages/infra/environments/production/secrets.yaml \
//     "bun run scripts/base-component-census.ts --target https://app.cedarpad.com"

import type { RoomSnapshot } from '@tldraw/sync-core';

import { CANVAS_SNAPSHOT_LABEL, canvasOperatorToken } from '../shared/canvas-operator-token.ts';
import { BASE_COMPONENTS } from '../worker/base-manifest.generated.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const target = opt('target') ?? 'https://app.cedarpad.com';
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  console.error('❌ BETTER_AUTH_SECRET is not set. Run under `sops exec-env <secrets.yaml>`.');
  process.exit(1);
}

/** R2 is authoritative for WHICH canvases exist — the D1 `canvases` table misses some
 *  (the legacy `default` canvas has no row at all). Same enumeration as page-census.ts. */
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

type Doc = { state: Record<string, unknown> };

const canvases = await listCanvases();
console.log(`→ READ-ONLY base-component census over ${canvases.length} canvas(es) at ${target}\n`);

/** module name → canvas ids holding a card of it. */
const sightings = new Map<string, Set<string>>();
let failed = 0;

for (const canvas of canvases) {
  const headers = { authorization: `Bearer ${await canvasOperatorToken(secret, CANVAS_SNAPSHOT_LABEL, canvas)}` };
  const res = await fetch(`${target}/api/canvas-sync/${canvas}/snapshot`, { headers });
  if (!res.ok) {
    console.log(`  ✗ ${canvas} — read ${res.status}`);
    failed += 1;
    continue;
  }
  const docs = (await res.json() as RoomSnapshot).documents as unknown as Doc[];
  for (const d of docs) {
    if (d.state?.typeName !== 'shape' || d.state.type !== 'component') continue;
    // The live DO format nests the module under `props`; older R2-derived blobs put it at
    // the top level. Read both, or the census silently sees zero components.
    const props = d.state.props as { module?: unknown } | undefined;
    const module = String(props?.module ?? (d.state as { module?: unknown }).module ?? '');
    if (!module) continue;
    if (!sightings.has(module)) sightings.set(module, new Set());
    sightings.get(module)!.add(canvas);
  }
}

const baseNames = BASE_COMPONENTS.map((b) => b.name).sort();
const unused = baseNames.filter((n) => !sightings.has(n));
const used = baseNames.filter((n) => sightings.has(n));

console.log(`\n── BUILT-IN Components nothing renders (${unused.length} of ${baseNames.length}) ──`);
for (const n of unused) console.log(`  ${n}`);

console.log(`\n── in use (${used.length}) ──`);
for (const n of used) console.log(`  ${n.padEnd(28)} ${sightings.get(n)!.size} canvas(es)`);

// Cards naming a module NO tier provides are the dead ones — a separate cleanup, and the
// reason they are worth printing here is that this census is the only thing that sees them.
const orphans = [...sightings.keys()].filter((n) => !baseNames.includes(n)).sort();
console.log(`\n── modules placed but NOT built-in (${orphans.length}) ──`);
console.log('   (own/shared Records, or dead cards — this census cannot tell them apart)');
for (const n of orphans) console.log(`  ${n.padEnd(28)} ${sightings.get(n)!.size} canvas(es)`);

if (failed) console.log(`\n⚠ ${failed} canvas(es) FAILED to read — treat the unused list as incomplete.`);
