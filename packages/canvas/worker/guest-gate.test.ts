import { describe, expect, test } from 'bun:test';
import type { GuestSession } from './guest-session.ts';
import { decideGuestGate } from './guest-gate.ts';

// The guest confinement boundary (PRD #220 slice 4, ADR-0015). PURE, like decideGate:
// default-deny with an explicit per-canvas allowlist. Every new edge/bridge route is
// guest-denied until listed here — that's the security model, so this table is the spec.

const guest: GuestSession = { linkId: 'sl_1', canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: false };

const allow = (pathname: string, method = 'GET', canvas?: string) =>
  decideGuestGate({ pathname, method, canvas: canvas ?? null }, guest).decision === 'allow';

describe('decideGuestGate — Shell + pad surface', () => {
  test('the Shell SPA and its assets are allowed (guest mode renders from the same bundle)', () => {
    expect(allow('/')).toBe(true);
    expect(allow('/assets/index-abc.js')).toBe(true);
  });

  test("the guest's own pad route is allowed; any other canvas or workspace is denied", () => {
    expect(allow('/w/ws_g/canvas/cv_g/pad')).toBe(true);
    expect(allow('/w/ws_g/canvas/cv_other/pad')).toBe(false);
    expect(allow('/w/ws_other/canvas/cv_g/pad')).toBe(false);
  });

  test('vite dev-server module paths are allowed GET-only (the pad cannot boot without them)', () => {
    // /shared/* is a real import prefix of the pad app (chat-store.ts, dock-messages.ts) —
    // its 401 broke the whole module graph for guests in prod (2026-07-16).
    for (const p of ['/src/App.tsx', '/shared/chat-store.ts', '/@vite/client', '/@fs/x', '/@id/y', '/node_modules/react/index.js', '/@react-refresh']) {
      expect(allow(p)).toBe(true);
      expect(allow(p, 'POST')).toBe(false);
    }
  });
});

describe('decideGuestGate — canvas API, scoped by the x-canvas-id the client stamps', () => {
  test("the component library READS are allowed when addressed to the guest's canvas", () => {
    expect(allow('/api/components', 'GET', 'cv_g')).toBe(true);
    expect(allow('/api/components/MyCard', 'GET', 'cv_g')).toBe(true);
    expect(allow('/api/components/data/MyCard', 'GET', 'cv_g')).toBe(true);
  });

  // ADR-0019 / #297. The two guest doors used to disagree: #294 made the guest's sync
  // WebSocket read-only at the protocol level, while these bridge routes stayed allowlisted
  // and — since #305 — wrote to the room under the CONTAINER's service credential. Retiring
  // the routes and de-allowlisting them had to happen together, or the allowlist would
  // authorize a guest to reach a 404 (the mistake #293 avoided for presence).
  test('every canvas WRITE on the old wire is denied, addressed or not', () => {
    for (const [p, m] of [
      ['/api/canvas/shapes', 'POST'],
      ['/api/canvas/shapes/create', 'POST'],
      ['/api/canvas/shapes/update', 'POST'],
      ['/api/canvas/delete', 'POST'],
      ['/api/components/place', 'POST'],
      // Executable component source that hot-reloads into MEMBERS' browsers. Not part of the
      // old sync plane, closed deliberately: it would otherwise be the one accidental guest
      // write path left standing. #320 owns whether guests get it back.
      ['/api/components/MyCard', 'PUT'],
      ['/api/components/data/MyCard', 'PUT'],
    ] as const) {
      expect(allow(p, m, 'cv_g')).toBe(false);
    }
  });

  // The document reaches a guest over the read-only room connection now (#294), and guest
  // mart authorization reads the room too (#289). Nothing is left for these to serve.
  test('the retired canvas reads on the old wire are no longer allowlisted', () => {
    expect(allow('/api/canvas', 'GET', 'cv_g')).toBe(false);
    expect(allow('/api/canvas/stream', 'GET', 'cv_g')).toBe(false);
  });

  // #293: presence moved onto the sync protocol, so the bridge no longer serves a
  // heartbeat route. Leaving it in the allowlist would authorize a guest to reach a 404
  // — dead authorization, and the kind that quietly outlives the thing it guarded.
  test('the deleted presence heartbeat route is no longer allowlisted', () => {
    expect(allow('/api/canvas/presence', 'POST', 'cv_g')).toBe(false);
  });

  test('the liveness ping is allowed WITHOUT a canvas address (the client sends none — prod 401, 2026-07-16)', () => {
    expect(allow('/api/alive', 'POST')).toBe(true);
    expect(allow('/api/alive', 'POST', 'cv_g')).toBe(true);
  });

  test('the SAME ops addressed to another canvas — or with NO canvas at all — are denied (no default-canvas fallback for guests)', () => {
    expect(allow('/api/components', 'GET', 'cv_other')).toBe(false);
    expect(allow('/api/components', 'GET')).toBe(false);
    expect(allow('/api/components/MyCard', 'GET', 'cv_other')).toBe(false);
    expect(allow('/api/components/MyCard', 'GET')).toBe(false);
  });

  test('cross-canvas blast radius is denied even correctly addressed: promote/adopt (shared tier), clear (destructive)', () => {
    expect(allow('/api/components/promote', 'POST', 'cv_g')).toBe(false);
    expect(allow('/api/components/adopt', 'POST', 'cv_g')).toBe(false);
    expect(allow('/api/canvas/clear', 'POST', 'cv_g')).toBe(false);
  });
});

describe('decideGuestGate — everything else is denied by default', () => {
  test('workspace/registry/inbox/admin/jobs/dev-agent/skills/chat surfaces are denied', () => {
    for (const p of [
      '/api/workspaces',
      '/api/canvases',
      '/api/canvases/cv_g/share-links',
      '/api/inbox',
      '/inbox/conv_1/bridge/api/chat/stream',
      '/api/admin/waitlist',
      '/api/jobs/dev-agent/run',
      '/api/dev-agent/run',
      '/api/skills/foo',
      '/api/sessions',
      '/api/status',
      '/__recycle',
      '/__bootlog',
      '/notebook',
      '/v1/observations',
    ]) {
      expect(allow(p, 'GET', 'cv_g')).toBe(false);
      expect(allow(p, 'POST', 'cv_g')).toBe(false);
    }
  });
});

describe('decideGuestGate — chat (#220 slice 6)', () => {
  const chatty: GuestSession = { ...guest, guestChat: true };
  const allowFor = (g: GuestSession, pathname: string, method: string, canvas?: string) =>
    decideGuestGate({ pathname, method, canvas: canvas ?? null }, g).decision === 'allow';

  test('every guest may WATCH: the shared stream and per-chat transcripts (bridge filters by canvas)', () => {
    expect(allow('/api/chat/stream')).toBe(true); // EventSource can't stamp headers — bridge-side confinement
    expect(allow('/api/chat/c1/transcript', 'GET')).toBe(true);
  });

  test('send/interrupt exist only on guestChat links, addressed to the link canvas', () => {
    expect(allow('/api/chat/c1/send', 'POST', 'cv_g')).toBe(false); // this link has guestChat: false
    expect(allowFor(chatty, '/api/chat/c1/send', 'POST', 'cv_g')).toBe(true);
    expect(allowFor(chatty, '/api/chat/c1/interrupt', 'POST', 'cv_g')).toBe(true);
    expect(allowFor(chatty, '/api/chat/c1/send', 'POST', 'cv_other')).toBe(false);
    expect(allowFor(chatty, '/api/chat/c1/send', 'POST')).toBe(false);
  });

  test('config/fork stay denied even on a guestChat link (server-owned ChatMeta is not guest surface)', () => {
    expect(allowFor(chatty, '/api/chat/c1/config', 'POST', 'cv_g')).toBe(false);
    expect(allowFor(chatty, '/api/chat/c1/fork', 'POST', 'cv_g')).toBe(false);
  });
});

// PRD #221: a component-scoped link (shapeId set) shares an artifact, not a conversation.
// The module READ surface is unchanged (the accepted v1 confinement gap, ADR-0015
// amendment); the ENTIRE chat surface is denied.
describe('decideGuestGate — component-scoped links (#221)', () => {
  const compGuest: GuestSession = { ...guest, guestChat: true, shapeId: 'shape:abc' };
  const compAllow = (pathname: string, method = 'GET', canvas?: string) =>
    decideGuestGate({ pathname, method, canvas: canvas ?? null }, compGuest).decision === 'allow';

  test('keeps the module READ surface, and writes nothing (#297)', () => {
    expect(compAllow('/api/components', 'GET', 'cv_g')).toBe(true);
    expect(compAllow('/api/components/MyCard', 'GET', 'cv_g')).toBe(true);
    expect(compAllow('/src/App.tsx')).toBe(true);
    expect(compAllow('/api/alive', 'POST')).toBe(true);
    expect(compAllow('/api/canvas/shapes/update', 'POST', 'cv_g')).toBe(false);
    expect(compAllow('/api/components/MyCard', 'PUT', 'cv_g')).toBe(false);
  });

  test('denies the whole chat surface — even with guestChat set on the row', () => {
    expect(compAllow('/api/chat/stream', 'GET')).toBe(false);
    expect(compAllow('/api/chat/c1/transcript', 'GET')).toBe(false);
    expect(compAllow('/api/chat/c1/send', 'POST', 'cv_g')).toBe(false);
    expect(compAllow('/api/chat/c1/interrupt', 'POST', 'cv_g')).toBe(false);
  });
});
