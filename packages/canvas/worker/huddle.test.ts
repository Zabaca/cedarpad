import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { create as createCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { GuestSession } from './guest-session.ts';
import { handleGuestHuddleJoin, handleHuddleJoin } from './huddle.ts';

// Huddles (ADR-0017): POST /api/canvases/:id/huddle/join mints a LiveKit room token
// scoped to exactly that canvas's room, member-checked through the canvas's workspace
// (same access rule as share links). Signing keys stay edge-side; the response carries
// only {url, token, room}. In-memory DB from the real migrations (house pattern).
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

const MEMBER = { id: 'member_1' };

const LK = { LIVEKIT_URL: 'wss://test.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 'secret-secret-secret' };

let canvasId: string;

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  await db.insert(schema.user).values({ id: 'member_1', name: 'member_1', email: 'm@example.com' });
  const ws = await createWorkspace(db, { name: 'huddle-ws', ownerUserId: 'member_1' });
  const canvas = await createCanvas(db, { workspaceId: ws.id, name: 'board' });
  canvasId = canvas.id;
});

const joinReq = () => new Request('https://edge.test/api/canvases/x/huddle/join', { method: 'POST' });

const decodeJwt = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString());

describe('huddle join — member path mints a canvas-scoped room token', () => {
  test('a member gets {url, token, room}; the token grant is that canvas room under their identity', async () => {
    const res = await handleHuddleJoin(joinReq(), database, MEMBER, canvasId, LK);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; token: string; room: string };
    expect(body.url).toBe(LK.LIVEKIT_URL);
    expect(body.room).toBe(canvasId);
    const claims = decodeJwt(body.token);
    expect(claims.sub).toBe(MEMBER.id);
    expect(claims.iss).toBe(LK.LIVEKIT_API_KEY);
    expect(claims.video.room).toBe(canvasId);
    expect(claims.video.roomJoin).toBe(true);
  });

  test('a non-member gets 404 (never 403 — existence is not confirmed)', async () => {
    await db.insert(schema.user).values({ id: 'stranger_1', name: 'stranger_1', email: 's@example.com' });
    const res = await handleHuddleJoin(joinReq(), database, { id: 'stranger_1' }, canvasId, LK);
    expect(res.status).toBe(404);
  });
});

describe('huddle join — guest path (guestHuddle link capability)', () => {
  const guest = (over: Partial<GuestSession>): GuestSession => ({
    linkId: 'sl_link1',
    canvasId: 'cv_guest',
    workspaceId: 'ws_guest',
    guestChat: false,
    guestHuddle: true,
    ...over,
  });

  test('a guestHuddle guest gets a token for the link canvas under a guest identity', async () => {
    const res = await handleGuestHuddleJoin(joinReq(), guest({}), 'cv_guest', LK);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; room: string };
    expect(body.room).toBe('cv_guest');
    const claims = decodeJwt(body.token);
    expect(claims.sub).toBe('guest:sl_link1');
    expect(claims.video.room).toBe('cv_guest');
  });

  test('denied without the capability, and for a canvas other than the link canvas', async () => {
    expect((await handleGuestHuddleJoin(joinReq(), guest({ guestHuddle: false }), 'cv_guest', LK)).status).toBe(404);
    expect((await handleGuestHuddleJoin(joinReq(), guest({}), 'cv_other', LK)).status).toBe(404);
  });
});
