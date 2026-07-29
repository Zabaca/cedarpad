import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import * as schema from '../web-poc/lib/db/schema.ts';
import { d1RecordStore } from './record-store.ts';
import { handleComponentsApi } from './components-api.ts';

// `GET /api/components` served at the EDGE (PRD #354 story 29): browsing the library must
// not wake and bill a container. The handler never gets a bridge to proxy to — if it needed
// one, these tests could not construct it.

// In-memory DB built from the real migrations (mirrors members.test.ts).
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
const db = drizzle(client, { schema }) as never;

const MEMBER = { id: 'user_ca1', email: 'user_ca1@example.com' };
const OUTSIDER = { id: 'user_ca2', email: 'user_ca2@example.com' };

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const u of [MEMBER, OUTSIDER]) {
    await client.execute({ sql: 'insert into user (id, name, email) values (?, ?, ?)', args: [u.id, u.id, u.email] });
  }
});

describe('the edge component listing', () => {
  test("answers a canvas's library from Records and the platform manifest, with tier labels", async () => {
    const ws = await createWorkspace(db, { name: 'catalog-ws', ownerUserId: MEMBER.id });
    const cv = await canvasRegistry.create(db, { workspaceId: ws.id, name: 'board', createdBy: MEMBER.id });
    await d1RecordStore(db).put({
      workspaceId: ws.id,
      canvasId: cv.id,
      name: 'SalesCard',
      kind: 'component',
      source: '// Quarterly sales.\nexport default () => null;',
      updatedBy: MEMBER.id,
    });

    const res = await handleComponentsApi(db, MEMBER, ws.id, cv.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { components: string[]; details: { name: string; description: string; tier: string }[] };

    expect(body.details).toContainEqual({ name: 'SalesCard', description: 'Quarterly sales.', tier: 'own' });
    // The platform tier, which lives only on the image, is in the answer too.
    expect(body.details.find((d) => d.name === 'BarChart')?.tier).toBe('base');
    // `components` is the bare-name list existing callers already read.
    expect(body.components).toEqual(body.details.map((d) => d.name));
  });

  // The legacy `default` canvas has no registry row and is always selectable inside a
  // workspace the caller belongs to (the same rule the pad routes apply), so a caller that
  // names no canvas still sees the workspace's shared library and the platform tier.
  test("an unnamed canvas resolves to the workspace's default, and still lists shared and base", async () => {
    const ws = await createWorkspace(db, { name: 'default-canvas-ws', ownerUserId: MEMBER.id });
    await d1RecordStore(db).put({
      workspaceId: ws.id,
      canvasId: null,
      name: 'SharedCard',
      kind: 'component',
      source: '// The workspace copy.\n',
      updatedBy: MEMBER.id,
    });

    const res = await handleComponentsApi(db, MEMBER, ws.id, 'default');
    expect(res.status).toBe(200);
    const { details } = (await res.json()) as { details: { name: string; tier: string }[] };
    expect(details).toContainEqual({ name: 'SharedCard', description: 'The workspace copy.', tier: 'shared' });
    expect(details.find((d) => d.name === 'BarChart')?.tier).toBe('base');
  });

  test('a canvas the caller may not read is not a library it can list', async () => {
    const ws = await createWorkspace(db, { name: 'private-ws', ownerUserId: MEMBER.id });
    const cv = await canvasRegistry.create(db, { workspaceId: ws.id, name: 'board', createdBy: MEMBER.id });

    expect((await handleComponentsApi(db, OUTSIDER, ws.id, cv.id)).status).toBe(404);
  });

  test("a canvas in another workspace is not reachable by naming this one's id", async () => {
    const mine = await createWorkspace(db, { name: 'mine', ownerUserId: MEMBER.id });
    const theirs = await createWorkspace(db, { name: 'theirs', ownerUserId: MEMBER.id });
    const cv = await canvasRegistry.create(db, { workspaceId: theirs.id, name: 'board', createdBy: MEMBER.id });

    expect((await handleComponentsApi(db, MEMBER, mine.id, cv.id)).status).toBe(404);
  });
});
