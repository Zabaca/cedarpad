import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { create as createCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import { getActiveShareLink } from '../web-poc/lib/db/queries/share-links.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { handleShareLinksApi } from './share-links-api.ts';

// The member-facing half of the guest door (PRD #220 slice 2, ADR-0015): mint/list/revoke
// share links for a canvas, member-checked through the canvas's workspace. In-memory DB
// from the real migrations (house pattern).
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
const STRANGER = { id: 'stranger_1' };

let canvasId: string;
let workspaceId: string;

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const id of ['member_1', 'stranger_1']) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
  const ws = await createWorkspace(db, { name: 'shared-ws', ownerUserId: 'member_1' });
  workspaceId = ws.id;
  const canvas = await createCanvas(db, { workspaceId: ws.id, name: 'board' });
  canvasId = canvas.id;
});

const req = (method: string, body?: unknown) =>
  new Request('https://edge.test/api/canvases/x/share-links', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });

describe('share-links API — mint/list/revoke, member-checked via the canvas', () => {
  test('a member mints a link: 201 with the link row, and it resolves active', async () => {
    const res = await handleShareLinksApi(req('POST', { guestChat: true }), database, MEMBER, canvasId);
    expect(res.status).toBe(201);
    const link = (await res.json()) as { id: string; canvasId: string; guestChat: boolean };
    expect(link.canvasId).toBe(canvasId);
    expect(link.guestChat).toBe(true);
    expect(await getActiveShareLink(db, link.id)).not.toBeNull();
  });

  test('a stranger gets 404 (never 403 — existence is not confirmed) on every method', async () => {
    for (const r of [req('POST', {}), req('GET'), req('DELETE')]) {
      const res = await handleShareLinksApi(r, database, STRANGER, canvasId, 'sl_whatever');
      expect(res.status).toBe(404);
    }
  });

  test('an unknown canvas is 404 even for a real member', async () => {
    const res = await handleShareLinksApi(req('POST', {}), database, MEMBER, 'cv_ghost');
    expect(res.status).toBe(404);
  });

  test('GET lists the canvas links, revoked ones included', async () => {
    const res = await handleShareLinksApi(req('GET'), database, MEMBER, canvasId);
    expect(res.status).toBe(200);
    const { links } = (await res.json()) as { links: Array<{ id: string }> };
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  test('DELETE revokes the link — it stops resolving active', async () => {
    const minted = await handleShareLinksApi(req('POST', {}), database, MEMBER, canvasId);
    const { id } = (await minted.json()) as { id: string };
    const res = await handleShareLinksApi(req('DELETE'), database, MEMBER, canvasId, id);
    expect(res.status).toBe(204);
    expect(await getActiveShareLink(db, id)).toBeNull();
  });

  test("DELETE with another canvas's link id is 404 and does NOT revoke it", async () => {
    const otherCanvas = await createCanvas(db, { workspaceId, name: 'other' });
    const minted = await handleShareLinksApi(req('POST', {}), database, MEMBER, otherCanvas.id);
    const { id } = (await minted.json()) as { id: string };
    const res = await handleShareLinksApi(req('DELETE'), database, MEMBER, canvasId, id);
    expect(res.status).toBe(404);
    expect(await getActiveShareLink(db, id)).not.toBeNull();
  });

  test('invalid mint body (guestChat not a boolean) is 400', async () => {
    const res = await handleShareLinksApi(req('POST', { guestChat: 'yes' }), database, MEMBER, canvasId);
    expect(res.status).toBe(400);
  });
});

// PRD #221: minting with a shapeId narrows the link to one placed component. guestChat is
// meaningless on a component link and is forced false regardless of what the body claims.
describe('component-scoped mint (#221)', () => {
  test('shapeId round-trips on the row and forces guestChat false', async () => {
    const res = await handleShareLinksApi(req('POST', { shapeId: 'shape:abc', guestChat: true }), database, MEMBER, canvasId);
    expect(res.status).toBe(201);
    const link = (await res.json()) as { id: string; shapeId: string | null; guestChat: boolean };
    expect(link.shapeId).toBe('shape:abc');
    expect(link.guestChat).toBe(false);
    expect((await getActiveShareLink(db, link.id))?.shapeId).toBe('shape:abc');
  });

  test('a canvas link keeps shapeId null', async () => {
    const res = await handleShareLinksApi(req('POST', {}), database, MEMBER, canvasId);
    expect(((await res.json()) as { shapeId: string | null }).shapeId).toBeNull();
  });
});
