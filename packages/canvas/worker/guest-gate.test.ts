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
    for (const p of ['/src/App.tsx', '/@vite/client', '/@fs/x', '/@id/y', '/node_modules/react/index.js', '/@react-refresh']) {
      expect(allow(p)).toBe(true);
      expect(allow(p, 'POST')).toBe(false);
    }
  });
});

describe('decideGuestGate — canvas API, scoped by the x-canvas-id the client stamps', () => {
  test("canvas read/sync/write ops are allowed when addressed to the guest's canvas", () => {
    expect(allow('/api/canvas', 'GET', 'cv_g')).toBe(true);
    expect(allow('/api/canvas/stream', 'GET', 'cv_g')).toBe(true);
    expect(allow('/api/canvas/presence', 'POST', 'cv_g')).toBe(true);
    expect(allow('/api/canvas/shapes', 'POST', 'cv_g')).toBe(true);
    expect(allow('/api/canvas/shapes/create', 'POST', 'cv_g')).toBe(true);
    expect(allow('/api/canvas/shapes/update', 'POST', 'cv_g')).toBe(true);
    expect(allow('/api/canvas/delete', 'POST', 'cv_g')).toBe(true);
    expect(allow('/api/components', 'GET', 'cv_g')).toBe(true);
    expect(allow('/api/components/MyCard', 'GET', 'cv_g')).toBe(true);
    expect(allow('/api/components/MyCard', 'PUT', 'cv_g')).toBe(true);
    expect(allow('/api/components/data/MyCard', 'PUT', 'cv_g')).toBe(true);
    expect(allow('/api/components/place', 'POST', 'cv_g')).toBe(true);
    expect(allow('/api/alive', 'POST', 'cv_g')).toBe(true);
  });

  test('the SAME ops addressed to another canvas — or with NO canvas at all — are denied (no default-canvas fallback for guests)', () => {
    expect(allow('/api/canvas', 'GET', 'cv_other')).toBe(false);
    expect(allow('/api/canvas', 'GET')).toBe(false);
    expect(allow('/api/canvas/shapes', 'POST', 'cv_other')).toBe(false);
    expect(allow('/api/components/MyCard', 'PUT')).toBe(false);
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
