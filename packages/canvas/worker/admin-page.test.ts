import { beforeEach, describe, expect, test } from 'bun:test';

import type { AdminOverview } from '../web-poc/lib/db/queries/admin-overview.ts';
import { resetJwksCache } from './access-jwt.ts';
import { AUD, NOW, TEAM, goodClaims, jwksPort, mint, sign } from './access-testkit.ts';
import { type AdminDeps, type ContainerStatus, handleAdminHost, isAdminHost, renderAdminPage } from './admin-page.ts';
import type { Env } from './index.ts';

// The admin host (ADR-0026). The gate fails closed, only `/` exists, and the page shows
// what the overview holds — escaped — and nothing the overview was built to leave out.

const signer = await mint('k1');
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as unknown as Env;

const overview: AdminOverview = {
  users: [
    { id: 'u1', email: 'james@zabaca.com', name: '<b>James</b>', role: 'admin', banned: false, createdAt: new Date(0), lastSeen: new Date(NOW) },
    { id: 'u2', email: 'm@example.com', name: 'Member', role: null, banned: true, createdAt: new Date(0), lastSeen: null },
  ],
  workspaces: [
    { id: 'default', name: 'Default', ownerUserId: 'u1', createdAt: new Date(0), memberUserIds: ['u2'], canvases: 20, components: 3, skillFiles: 1 },
    { id: 'ws_2', name: 'Two"><script>', ownerUserId: 'u2', createdAt: new Date(0), memberUserIds: [], canvases: 0, components: 0, skillFiles: 0 },
  ],
  shareLinks: [
    { id: 'sl_1', canvasId: 'cv_1', workspaceId: 'default', createdBy: 'u1', guestChat: true, guestHuddle: false, guestInteract: true, guestEdit: false, guestEditSource: false, createdAt: new Date(0), revokedAt: null },
  ],
  mcpTokens: [{ workspaceId: 'default', mcpName: 'fredrin', createdAt: new Date(0) }],
};

const statuses: Record<string, ContainerStatus> = {
  default: { kind: 'vm', origin: 'https://ws.cedarpad.com' },
  ws_2: { kind: 'durable', running: false, lastBoot: { at: new Date(NOW).toISOString(), ms: 3868, outcome: 'ready' } },
};

const deps = (): AdminDeps => ({
  fetch: jwksPort([signer]).fetch,
  now: () => NOW,
  overview: async () => overview,
  containerStatus: async (id) => statuses[id] ?? { kind: 'sandbox' },
});

const req = async (path = '/', init: RequestInit & { jwt?: string | null } = {}) => {
  const jwt = init.jwt === undefined ? await sign(signer, goodClaims()) : init.jwt;
  const headers = new Headers(init.headers);
  if (jwt) headers.set('cf-access-jwt-assertion', jwt);
  return new Request(`https://admin.cedarpad.com${path}`, { ...init, headers });
};

beforeEach(() => resetJwksCache());

describe('the admin host', () => {
  test('is admin.cedarpad.com and nothing else', () => {
    expect(isAdminHost(new URL('https://admin.cedarpad.com/'))).toBe(true);
    expect(isAdminHost(new URL('https://app.cedarpad.com/admin'))).toBe(false);
  });

  test('refuses everything when Access is not configured', async () => {
    for (const bad of [{}, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }, { ACCESS_TEAM_DOMAIN: 'evil.com', ACCESS_AUD: AUD }]) {
      const res = await handleAdminHost(await req(), bad as unknown as Env, deps());
      expect(res.status).toBe(503);
    }
  });

  test('403s a request with no assertion, a forged one, or one for another application', async () => {
    const forger = await mint('k1');
    for (const jwt of [null, 'garbage', await sign(forger, goodClaims()), await sign(signer, goodClaims({ aud: ['00'.repeat(32)] }))]) {
      const res = await handleAdminHost(await req('/', { jwt }), env, deps());
      expect(res.status).toBe(403);
    }
  });

  test('serves the page at / and 404s every other path or method', async () => {
    const ok = await handleAdminHost(await req(), env, deps());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/html');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await handleAdminHost(await req('/api/admin/waitlist'), env, deps())).status).toBe(404);
    expect((await handleAdminHost(await req('/', { method: 'POST' }), env, deps())).status).toBe(404);
  });
});

describe('renderAdminPage', () => {
  const html = renderAdminPage(overview, new Map(Object.entries(statuses)), { viewer: 'james@zabaca.com', now: NOW });

  test('escapes every value it interpolates', () => {
    expect(html).not.toContain('<b>James</b>');
    expect(html).toContain('&lt;b&gt;James&lt;/b&gt;');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('Two&quot;&gt;&lt;script&gt;');
  });

  test('shows users, memberships, counts, container status, links and MCP servers', () => {
    expect(html).toContain('james@zabaca.com');
    expect(html).toContain('Default (owner)');
    expect(html).toContain('banned');
    expect(html).toContain('VM · https://ws.cedarpad.com');
    expect(html).toContain('cloudflare · asleep · last boot ready 3.9s');
    expect(html).toContain('interact, chat');
    expect(html).toContain('fredrin');
  });
});
