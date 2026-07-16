import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { createShareLink, revokeShareLink } from '../web-poc/lib/db/queries/share-links.ts';
import { handleShareAccept, mintGuestCookie, readGuestSession } from './guest-session.ts';

// The guest door (PRD #220 slice 3, ADR-0015): /share/<linkId> validates the capability row
// and mints a SIGNED guest-session cookie; the gate (slice 4) reads it. The cookie is the
// credential — it must round-trip, and any tamper or wrong secret must resolve to null.

const SECRET = 'test-secret-at-least-32-characters-long!!';
const PAYLOAD = { linkId: 'sl_1', canvasId: 'cv_1', workspaceId: 'ws_1', guestChat: false };

describe('guest-session cookie — signed, tamper-proof', () => {
  test('mint → read round-trips the payload', async () => {
    const cookie = await mintGuestCookie(SECRET, PAYLOAD);
    expect(await readGuestSession(`cs_guest=${cookie}`, SECRET)).toEqual(PAYLOAD);
  });

  test('a tampered payload (canvas swapped) reads as null', async () => {
    const cookie = await mintGuestCookie(SECRET, PAYLOAD);
    const [, sig] = cookie.split('.');
    const forged = `${btoa(JSON.stringify({ ...PAYLOAD, canvasId: 'cv_other' })).replaceAll('=', '')}.${sig}`;
    expect(await readGuestSession(`cs_guest=${forged}`, SECRET)).toBeNull();
  });

  test('a cookie minted under a different secret reads as null', async () => {
    const cookie = await mintGuestCookie('another-secret-also-32-characters-long!!!', PAYLOAD);
    expect(await readGuestSession(`cs_guest=${cookie}`, SECRET)).toBeNull();
  });

  test('absent or garbage cookie header reads as null', async () => {
    expect(await readGuestSession(null, SECRET)).toBeNull();
    expect(await readGuestSession('cs_guest=garbage', SECRET)).toBeNull();
    expect(await readGuestSession('other=1', SECRET)).toBeNull();
  });
});

// --- the door itself, against a real in-memory DB ---
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}
const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
});

const mkLink = (guestChat = false) =>
  createShareLink(db, { canvasId: 'cv_share', workspaceId: 'ws_share', createdBy: 'u_1', guestChat });

describe('/share/<linkId> — the guest door', () => {
  test('a live link mints the signed guest cookie and redirects into the app', async () => {
    const link = await mkLink(true);
    const res = await handleShareAccept(new Request(`https://edge.test/share/${link.id}`), database, SECRET, link.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('cs_guest=');
    expect(setCookie).toContain('HttpOnly');
    const cookieValue = setCookie.split(';')[0]?.split('cs_guest=')[1] ?? '';
    expect(await readGuestSession(`cs_guest=${cookieValue}`, SECRET)).toEqual({
      linkId: link.id,
      canvasId: 'cv_share',
      workspaceId: 'ws_share',
      guestChat: true,
    });
  });

  test('a revoked link mints nothing — 404, no cookie', async () => {
    const link = await mkLink();
    await revokeShareLink(db, link.id);
    const res = await handleShareAccept(new Request(`https://edge.test/share/${link.id}`), database, SECRET, link.id);
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('an unknown link is indistinguishable from a revoked one (404, no cookie)', async () => {
    const res = await handleShareAccept(new Request('https://edge.test/share/sl_nope'), database, SECRET, 'sl_nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

// PRD #221: component-scoped links ride the same cookie with an optional shapeId; cookies
// minted before the field existed must keep verifying (optional = the back-compat idiom).
import { GuestSessionPayload } from './guest-session.ts';

describe('component-scoped payloads (#221)', () => {
  test('shapeId round-trips through mint + read', async () => {
    const payload = { linkId: 'sl_1', canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: false, shapeId: 'shape:abc' };
    const cookie = await mintGuestCookie('s3cret', payload);
    expect(await readGuestSession(`cs_guest=${cookie}`, 's3cret')).toEqual(payload);
  });

  test('a pre-#221 payload (no shapeId) still parses', () => {
    const parsed = GuestSessionPayload.safeParse({ linkId: 'sl_1', canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: true });
    expect(parsed.success).toBe(true);
  });
});
