// READ-ONLY census: which canvases already hold more than one page, and how many shapes
// are stranded off the first one.
//
// Context: `PageMenu: null` removed the page SWITCHER but not the ability to make a page
// — tldraw's context menu offers "Move to page → New page" unless `options.maxPages <= 1`,
// which we never set. So a human could move shapes to a page they then had no UI to
// reach. This counts how often that actually happened before the fix ships.
//
// Writes NOTHING. No --apply, no POST. Enumerates R2 (authoritative for which canvases
// exist; the D1 `canvases` table misses some) and GETs each room's snapshot.
//
// Usage:
//   sops exec-env packages/infra/environments/production/secrets.yaml \
//     "bun run scripts/page-census.ts --target https://app.cedarpad.com"

import type { RoomSnapshot } from '@tldraw/sync-core';

import { CANVAS_SNAPSHOT_LABEL, canvasOperatorToken } from '../shared/canvas-operator-token.ts';

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
console.log(`→ READ-ONLY page census over ${canvases.length} canvas(es) at ${target}\n`);

let multi = 0;
let strandedTotal = 0;
let failed = 0;

for (const canvas of canvases) {
  const headers = { authorization: `Bearer ${await canvasOperatorToken(secret, CANVAS_SNAPSHOT_LABEL, canvas)}` };
  const res = await fetch(`${target}/api/canvas-sync/${canvas}/snapshot`, { headers });
  if (!res.ok) {
    console.log(`${canvas.padEnd(44)} ✗ read ${res.status}`);
    failed += 1;
    continue;
  }
  const snapshot = (await res.json()) as RoomSnapshot;
  const docs = snapshot.documents as unknown as Doc[];
  const pages = docs
    .filter((d) => d.state?.typeName === 'page')
    .sort((a, b) => String(a.state.index ?? '').localeCompare(String(b.state.index ?? '')));
  if (pages.length <= 1) continue;

  // Shapes whose parent chain does not reach the first page are the stranded ones.
  const byId = new Map(docs.map((d) => [String(d.state.id), d.state]));
  const first = String(pages[0]?.state.id);
  const pageOf = (s: Record<string, unknown>): string => {
    const seen = new Set<string>();
    let cur: Record<string, unknown> | undefined = s;
    while (cur && !seen.has(String(cur.id))) {
      seen.add(String(cur.id));
      const parent = String(cur.parentId ?? '');
      if (parent.startsWith('page:')) return parent;
      if (!parent.startsWith('shape:')) return first;
      cur = byId.get(parent);
    }
    return first;
  };
  const stranded = docs.filter((d) => d.state?.typeName === 'shape' && pageOf(d.state) !== first).length;
  multi += 1;
  strandedTotal += stranded;
  const names = pages.map((p) => `${String(p.state.name)}`).join(' | ');
  console.log(`${canvas.padEnd(44)} ${pages.length} pages [${names}] — ${stranded} shape(s) off page one`);
}

console.log(
  `\n${multi} of ${canvases.length} canvas(es) hold more than one page; ${strandedTotal} shape(s) currently unreachable in the browser.` +
    (failed ? ` ${failed} canvas(es) FAILED to read.` : ''),
);
