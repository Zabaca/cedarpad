import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { resolveCanvas, resolveCanvasWorkspace } from './access.ts';

// The access SEAM (#225): membership + ADR-0016 visibility composed once. Driven against a
// real in-memory libSQL built from the migrations, so
// the join the predicates need is the real one.
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

const OWNER = 'user_owner';
const MEMBER = 'user_member';
const STRANGER = 'user_stranger';

let wsId: string;
let publicCanvasId: string;
let privateCanvasId: string; // private, created by OWNER

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const id of [OWNER, MEMBER, STRANGER]) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
  await db.insert(schema.workspaces).values({ id: 'default', name: 'Default', ownerUserId: OWNER });
  const ws = await createWorkspace(database, { name: 'AccessWs', ownerUserId: OWNER });
  wsId = ws.id;
  await db.insert(schema.workspaceMembers).values({ id: 'wm_access', workspaceId: wsId, userId: MEMBER });

  publicCanvasId = (await canvasRegistry.create(database, { workspaceId: wsId, name: 'Public', createdBy: OWNER })).id;
  const priv = await canvasRegistry.create(database, { workspaceId: wsId, name: 'Private', createdBy: OWNER });
  await canvasRegistry.setVisibility(database, priv.id, 'private');
  privateCanvasId = priv.id;
});

describe('resolveCanvas (workspace-scoped)', () => {
  test('a member resolves a workspace-visible canvas', async () => {
    expect((await resolveCanvas(database, wsId, publicCanvasId, MEMBER))?.id).toBe(publicCanvasId);
  });

  test('a non-member gets null', async () => {
    expect(await resolveCanvas(database, wsId, publicCanvasId, STRANGER)).toBeNull();
  });

  test("someone else's private canvas is null; its creator resolves it", async () => {
    expect(await resolveCanvas(database, wsId, privateCanvasId, MEMBER)).toBeNull();
    expect((await resolveCanvas(database, wsId, privateCanvasId, OWNER))?.id).toBe(privateCanvasId);
  });

  test('a canvas from another workspace is null even for a member of both', async () => {
    const other = await createWorkspace(database, { name: 'Other', ownerUserId: OWNER });
    expect(await resolveCanvas(database, other.id, publicCanvasId, OWNER)).toBeNull();
    expect(await resolveCanvas(database, wsId, 'cv_missing', OWNER)).toBeNull();
  });
});

describe('resolveCanvasWorkspace (canvas addressed without its workspace)', () => {
  test('derives the workspace for a member; null for a stranger', async () => {
    expect(await resolveCanvasWorkspace(database, publicCanvasId, MEMBER)).toBe(wsId);
    expect(await resolveCanvasWorkspace(database, publicCanvasId, STRANGER)).toBeNull();
  });

  test('the legacy row-less `default` canvas maps to the default workspace', async () => {
    expect(await resolveCanvasWorkspace(database, 'default', OWNER)).toBe('default');
    expect(await resolveCanvasWorkspace(database, 'default', STRANGER)).toBeNull();
  });

  test("a private canvas is its creator's business only", async () => {
    expect(await resolveCanvasWorkspace(database, privateCanvasId, MEMBER)).toBeNull();
    expect(await resolveCanvasWorkspace(database, privateCanvasId, OWNER)).toBe(wsId);
  });
});
