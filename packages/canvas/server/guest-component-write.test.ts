// The bridge's half of the guest write decision (#320).
//
// The edge gate says which ROUTES a link's capabilities reach; the bridge holds the facts
// the edge cannot see — above all a module's TIER, which is filesystem state. So
// `guest_edit_source` is checked twice, deliberately, and the second check is the one that
// keeps the grant inside the invite: the OWN (canvas-scoped) tier only, never the
// workspace-shared tier that other canvases import.
//
// Both checks derive from `shared/guest-capabilities.ts`. That is the point of the slice —
// #297 happened because the gate and the bridge each decided for themselves, and the
// routes that survived wrote to the room under the CONTAINER's service credential.
//
// The room is unreachable in a unit run, so an ALLOWED write answers 502 after the file
// has landed. That is why the allowed cases assert the file, and the refused ones the 403:
// a refusal must happen before anything is written at all.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GUEST_CANVAS_HEADER, GUEST_CAPS_HEADER } from '../shared/bridge-wire.ts';
import { guestCapabilities, type GuestCapabilities } from '../shared/guest-capabilities.ts';
import { handleRequest } from './bridge.ts';
import { promoteComponent, readComponent, writeComponent } from './components.ts';

const CANVAS = 'cv_guestwrite';
const SOURCE = 'export default function C() { return null }\n';
/** Unique names so this file never collides with the seed library or a parallel run. */
const OWN = 'Tmp_GuestOwn';
const SHARED = 'Tmp_GuestShared';

const pathIn = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
afterAll(() => {
  for (const p of [
    `src/canvas-${CANVAS}/components/${OWN}.tsx`,
    `src/canvas-${CANVAS}/components/${SHARED}.tsx`,
    `src/canvas-${CANVAS}/components/Tmp_NoGrant.tsx`,
    `shared/components/${SHARED}.tsx`,
  ]) {
    if (existsSync(pathIn(p))) rmSync(pathIn(p));
  }
});

const guestReq = (path: string, method: string, caps: GuestCapabilities | null, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-canvas-id': CANVAS,
      ...(caps ? { [GUEST_CANVAS_HEADER]: CANVAS, [GUEST_CAPS_HEADER]: JSON.stringify(caps) } : {}),
    },
    body: JSON.stringify(body),
  });

const putSource = (module: string, caps: GuestCapabilities | null) =>
  guestReq(`/api/components/${module}`, 'PUT', caps, { source: SOURCE });

describe('PUT /api/components/:module — the one write #320 re-opens on this door', () => {
  test('a guest WITHOUT guest_edit_source is refused, and nothing is written', async () => {
    const res = await handleRequest(putSource('Tmp_NoGrant', guestCapabilities({ guestInteract: true, guestEdit: true })));
    expect(res.status).toBe(403);
    expect(existsSync(pathIn(`src/canvas-${CANVAS}/components/Tmp_NoGrant.tsx`))).toBe(false);
  });

  test('a guest whose capability header is missing or junk is refused (absence is never trust)', async () => {
    for (const header of ['', 'not json', '{"editSource":true}']) {
      const req = new Request(`http://localhost/api/components/Tmp_NoGrant`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-canvas-id': CANVAS,
          [GUEST_CANVAS_HEADER]: CANVAS,
          [GUEST_CAPS_HEADER]: header,
        },
        body: JSON.stringify({ source: SOURCE }),
      });
      expect((await handleRequest(req)).status).toBe(403);
    }
  });

  test('a guest WITH guest_edit_source writes an OWN-tier module', async () => {
    const res = await handleRequest(putSource(OWN, guestCapabilities({ guestEditSource: true })));
    expect(res.status).not.toBe(403);
    expect(await readComponent(OWN, CANVAS)).toBe(SOURCE);
  });

  // The residual risk #320 accepted is "arbitrary JS in a member's browser, BOUNDED TO THE
  // INVITED CANVAS". A shared module is the workspace's one source, imported by other
  // canvases — writing one leaves the bound, and only the bridge can see the tier.
  test('…but is refused a SHARED-tier module, though the route is identical', async () => {
    await writeComponent(SHARED, '// member source\n', CANVAS);
    promoteComponent(CANVAS, SHARED);
    const res = await handleRequest(putSource(SHARED, guestCapabilities({ guestEditSource: true })));
    expect(res.status).toBe(403);
    expect(await readComponent(SHARED, CANVAS)).toBe('// member source\n');
  });

  test('a member (no guest headers at all) is unaffected by any of this', async () => {
    const res = await handleRequest(putSource(SHARED, null));
    expect(res.status).not.toBe(403);
    expect(await readComponent(SHARED, CANVAS)).toBe(SOURCE);
  });
});

describe('the writes NO capability re-opens on this door', () => {
  const everything = guestCapabilities({
    guestChat: true,
    guestHuddle: true,
    guestInteract: true,
    guestEdit: true,
    guestEditSource: true,
  });

  test('promote and adopt stay denied — they reach the workspace-shared tier, outside the invite', async () => {
    for (const op of ['promote', 'adopt']) {
      const res = await handleRequest(guestReq(`/api/components/${op}`, 'POST', everything, { module: OWN }));
      expect(res.status).toBe(403);
    }
  });

  // The canvas document is written on the sync socket, as the guest. These routes wrote to
  // the room under the CONTAINER's service credential — the #297 bug — so they stay shut
  // here too, not only at the edge.
  test('the canvas-document routes stay denied to guests under every capability', async () => {
    for (const [p, body] of [
      ['/api/canvas/shapes/create', { shapes: [] }],
      ['/api/canvas/shapes/update', { shapes: [] }],
      ['/api/canvas/delete', { ids: [] }],
      ['/api/components/place', { module: OWN, x: 0, y: 0 }],
    ] as const) {
      expect((await handleRequest(guestReq(p, 'POST', everything, body))).status).toBe(403);
    }
  });

  test('component DATA files are authoring with no grant behind them — denied', async () => {
    const res = await handleRequest(guestReq('/api/components/data/rows.json', 'PUT', everything, { source: '[]' }));
    expect(res.status).toBe(403);
  });
});
