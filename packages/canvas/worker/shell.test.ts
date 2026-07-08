import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { handleCanvasesApi, renderLogin } from './shell.ts';

// In-memory DB built from the real migrations (mirrors canvases.test.ts / workspaces.test.ts).
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
const USER = { id: 'user_1' };
// `as never` bridges the node-libsql drizzle instance to the worker's Database type
// (structurally identical; the handler only calls the shared query helpers).
const database = db as never;

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  // Owners must exist — `workspaces.owner_user_id` FK-references `user`.
  await db.insert(schema.user).values({ id: USER.id, name: USER.id, email: `${USER.id}@example.com` });
});

// The Canvas app's registry API (ADR-0007, #54): GET/POST/PATCH/DELETE scoped to the
// active workspace (the cs_workspace cookie), mirroring handleWorkspacesApi.
describe('handleCanvasesApi — list/create scoped to the active workspace', () => {
  test('GET with no cookie scopes to the default workspace', async () => {
    await canvasRegistry.create(database, { workspaceId: 'default', name: 'Home' });
    const res = await handleCanvasesApi(new Request('https://x/api/canvases'), database, USER);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.workspaceId).toBe('default');
    expect(body.canvases.map((c: { name: string }) => c.name)).toContain('Home');
  });

  test('list is isolated per workspace (cs_workspace cookie selects the scope)', async () => {
    const ws = await createWorkspace(database, { name: 'Proj', ownerUserId: USER.id });
    const cookie = `cs_workspace=${ws.id}`;
    // Create into the selected workspace via the API itself.
    const created = await handleCanvasesApi(
      new Request('https://x/api/canvases', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Scoped' }),
      }),
      database,
      USER,
    );
    expect(created.status).toBe(201);

    const inWs = await readJson(await handleCanvasesApi(new Request('https://x/api/canvases', { headers: { cookie } }), database, USER));
    expect(inWs.workspaceId).toBe(ws.id);
    expect(inWs.canvases.map((c: { name: string }) => c.name)).toEqual(['Scoped']);

    // The default scope never sees the other workspace's canvas.
    const inDefault = await readJson(await handleCanvasesApi(new Request('https://x/api/canvases'), database, USER));
    expect(inDefault.canvases.map((c: { name: string }) => c.name)).not.toContain('Scoped');
  });

  test('a non-owned workspace selection ⇒ 404 (never leaks another owner’s canvases)', async () => {
    const res = await handleCanvasesApi(
      new Request('https://x/api/canvases', { headers: { cookie: 'cs_workspace=ws_someone_else' } }),
      database,
      USER,
    );
    expect(res.status).toBe(404);
  });

  test('PATCH/DELETE refuse a canvas outside the active workspace', async () => {
    const ws = await createWorkspace(database, { name: 'Other', ownerUserId: USER.id });
    const foreign = await canvasRegistry.create(database, { workspaceId: ws.id, name: 'Foreign' });
    // Active scope is default (no cookie); the foreign canvas lives in `ws`.
    const patch = await handleCanvasesApi(
      new Request('https://x/api/canvases/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) }),
      database,
      USER,
      foreign.id,
    );
    expect(patch.status).toBe(404);
  });
});

// The edge login page is what the SOLE gate (edge Better Auth, #45) serves on a deny
// after the #47 cutover — replacing the deleted cs_gate `?key=` page. It must let an
// unauthenticated user actually sign in, at the edge, without waking a container.
describe('renderLogin — the post-cutover deny page (edge Better Auth is the sole gate)', () => {
  test('is a 401 HTML deny', async () => {
    const res = renderLogin();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
    await res.text(); // drain
  });

  test('posts credentials to the PUBLIC edge Better Auth endpoints (so login needs no container)', async () => {
    const html = await renderLogin().text();
    expect(html).toContain('/api/auth/sign-in/email');
    expect(html).toContain('/api/auth/sign-up/email');
  });

  test('is the Better Auth login, NOT the deleted cs_gate ?key= page', async () => {
    const html = await renderLogin().text();
    expect(html).not.toContain('?key=');
    expect(html).not.toContain('cs_gate');
  });
});
