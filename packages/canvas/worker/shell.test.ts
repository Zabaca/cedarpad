import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { d1RecordStore } from './record-store.ts';
import { FIRST_CANVAS_NAME, handleCanvasesApi, handleRecordPurgeApi, handleWorkspacesApi, renderLogin } from './shell.ts';

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
  // #179: `default` has a real owned row (prod: the seed script); access is owner-OR-member.
  await db.insert(schema.workspaces).values({ id: 'default', name: 'Default', ownerUserId: USER.id });
});

// Workspace creation is admin-only (every workspace boots its own container), and a new
// workspace opens onto its own first canvas — never the row-less `default` canvas, which
// belongs to the `default` workspace alone.
describe('handleWorkspacesApi — admin-only creation, with a first canvas', () => {
  const ADMIN = { id: 'admin_1' };
  const post = (name: string) =>
    new Request('https://x/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: ADMIN.id, name: ADMIN.id, email: `${ADMIN.id}@example.com`, role: 'admin' });
  });

  test('a non-admin cannot create a workspace (403), and is told so on the list', async () => {
    const res = await handleWorkspacesApi(post('Nope'), database, USER);
    expect(res.status).toBe(403);
    const list = await readJson(await handleWorkspacesApi(new Request('https://x/api/workspaces'), database, USER));
    expect(list.canCreate).toBe(false);
    expect(list.workspaces.map((w: { name: string }) => w.name)).not.toContain('Nope');
  });

  test('an admin creates a workspace that owns its first canvas', async () => {
    const res = await handleWorkspacesApi(post('Acme'), database, ADMIN);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.name).toBe('Acme');
    const canvases = await canvasRegistry.list(database, body.id);
    expect(canvases.map((c) => ({ id: c.id, name: c.name, createdBy: c.createdBy }))).toEqual([
      { id: body.canvasId, name: FIRST_CANVAS_NAME, createdBy: ADMIN.id },
    ]);
    const list = await readJson(await handleWorkspacesApi(new Request('https://x/api/workspaces'), database, ADMIN));
    expect(list.canCreate).toBe(true);
    expect(list.workspaces.map((w: { id: string }) => w.id)).toContain(body.id);
  });
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

// ADR-0022 decision 9: deleting a canvas takes its Records with it, but only as far as the
// trash. Before Records, nothing removed a deleted canvas's components at all — the source
// leaked forever. A hard cascade would be the opposite dishonesty, so what a delete does is
// SOFT, and reclaiming is a separate act (`handleRecordPurgeApi`).
describe('handleCanvasesApi — DELETE soft-deletes the canvas’s Records', () => {
  test('the canvas’s own tier goes; the workspace’s shared library stays', async () => {
    const ws = await createWorkspace(database, { name: 'Deleting', ownerUserId: USER.id });
    const cookie = `cs_workspace=${ws.id}`;
    const canvas = await canvasRegistry.create(database, { workspaceId: ws.id, name: 'Doomed' });
    const records = d1RecordStore(database);
    const own = { workspaceId: ws.id, canvasId: canvas.id, name: 'Card' };
    await records.put({ ...own, kind: 'component', source: 'v1', updatedBy: USER.id });
    await records.put({ workspaceId: ws.id, canvasId: canvas.id, name: 'sales.json', kind: 'data', source: '[]', updatedBy: USER.id });
    await records.put({ workspaceId: ws.id, canvasId: null, name: 'Shared', kind: 'component', source: 's', updatedBy: USER.id });

    const res = await handleCanvasesApi(new Request('https://x/api/canvases/x', { method: 'DELETE', headers: { cookie } }), database, USER, canvas.id);
    expect(res.status).toBe(204);

    // Gone from every listing, and no longer resolvable — so nothing materializes it again.
    expect(await records.list({ workspaceId: ws.id, canvasId: canvas.id })).toEqual([]);
    expect(await records.get(own)).toBeNull();
    // But recoverable: the history is what a soft delete must not be able to destroy.
    expect((await records.listVersions(own)).map((v) => v.source)).toEqual(['v1']);
    // The shared library outlives any one canvas in the workspace.
    expect((await records.list({ workspaceId: ws.id, canvasId: null })).map((r) => r.name)).toEqual(['Shared']);
  });
});

// The other half of an honest delete: the one door that actually reclaims. It is a separate
// request a workspace OWNER makes, never a step of deleting a canvas — the whole reason a
// delete is soft is that no single click should be able to destroy source.
describe('handleRecordPurgeApi — the deliberate half', () => {
  test('the owner’s purge reclaims soft-deleted Records and their history, and spares live ones', async () => {
    const ws = await createWorkspace(database, { name: 'Purging', ownerUserId: USER.id });
    const canvas = await canvasRegistry.create(database, { workspaceId: ws.id, name: 'Doomed' });
    const records = d1RecordStore(database);
    const own = { workspaceId: ws.id, canvasId: canvas.id, name: 'Card' };
    await records.put({ ...own, kind: 'component', source: 'v1', updatedBy: USER.id });
    await records.put({ workspaceId: ws.id, canvasId: null, name: 'Shared', kind: 'component', source: 's', updatedBy: USER.id });
    await handleCanvasesApi(
      new Request('https://x/api/canvases/x', { method: 'DELETE', headers: { cookie: `cs_workspace=${ws.id}` } }),
      database,
      USER,
      canvas.id,
    );

    const res = await handleRecordPurgeApi(new Request('https://x/purge', { method: 'POST' }), database, USER, ws.id);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ purged: 1 });
    // Unrecoverable now — that is what "purge" means, and why it is its own request.
    expect(await records.listVersions(own)).toEqual([]);
    // A live Record is not trash: the shared library is untouched by emptying it.
    expect((await records.list({ workspaceId: ws.id, canvasId: null })).map((r) => r.name)).toEqual(['Shared']);
  });

  test('a member cannot purge, and an outsider is not even told the workspace exists', async () => {
    const ws = await createWorkspace(database, { name: 'Guarded', ownerUserId: USER.id });
    const records = d1RecordStore(database);
    const key = { workspaceId: ws.id, canvasId: 'cv_gone', name: 'Card' };
    await records.put({ ...key, kind: 'component', source: 'v1', updatedBy: USER.id });
    await records.softDelete(key);

    await db.insert(schema.user).values({ id: 'user_purge_member', name: 'm', email: 'm-purge@example.com' });
    await db.insert(schema.workspaceMembers).values({ id: 'wm_purge', workspaceId: ws.id, userId: 'user_purge_member' });
    const post = () => new Request('https://x/purge', { method: 'POST' });
    expect((await handleRecordPurgeApi(post(), database, { id: 'user_purge_member' }, ws.id)).status).toBe(403);
    expect((await handleRecordPurgeApi(post(), database, { id: 'user_purge_outsider' }, ws.id)).status).toBe(404);

    // A refused purge reclaimed nothing — the source is still there to restore.
    expect((await records.listVersions(key)).map((v) => v.source)).toEqual(['v1']);
  });
});

// ADR-0016: creator-private canvases. The registry API is the flip surface and the list
// is the filter surface; the workspace owner gets manage-not-read (locked rows, force-
// publish, delete — never open; the pad-route gate lives in index.ts).
describe('handleCanvasesApi — visibility (ADR-0016)', () => {
  const MEMBER = { id: 'user_vis_member' };
  const OWNER = { id: 'user_vis_owner' };
  let cookie = '';
  let canvasId = '';

  beforeAll(async () => {
    for (const u of [MEMBER, OWNER]) {
      await db.insert(schema.user).values({ id: u.id, name: u.id, email: `${u.id}@example.com` });
    }
    const ws = await createWorkspace(database, { name: 'Vis', ownerUserId: OWNER.id });
    await db.insert(schema.workspaceMembers).values({ id: 'wm_vis', workspaceId: ws.id, userId: MEMBER.id });
    cookie = `cs_workspace=${ws.id}`;
    const created = await readJson(
      await handleCanvasesApi(
        new Request('https://x/api/canvases', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Mine' }),
        }),
        database,
        MEMBER,
      ),
    );
    canvasId = created.id;
  });

  const patchVis = (user: { id: string }, visibility: string) =>
    handleCanvasesApi(
      new Request('https://x/api/canvases/x', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ visibility }),
      }),
      database,
      user,
      canvasId,
    );
  const list = async (user: { id: string }) =>
    (await readJson(await handleCanvasesApi(new Request('https://x/api/canvases', { headers: { cookie } }), database, user))).canvases;

  test('creation stamps the creator; rows carry visibility + mine', async () => {
    const rows = await list(MEMBER);
    expect(rows).toEqual([{ id: canvasId, name: 'Mine', visibility: 'workspace', mine: true }]);
    expect((await list(OWNER))[0]).toMatchObject({ mine: false });
  });

  test('the creator flips private; another member no longer lists it; the owner sees it locked', async () => {
    expect((await patchVis(MEMBER, 'private')).status).toBe(200);
    expect(await list(MEMBER)).toEqual([{ id: canvasId, name: 'Mine', visibility: 'private', mine: true }]);
    const ownerRows = await list(OWNER);
    expect(ownerRows).toEqual([
      { id: canvasId, name: 'Mine', visibility: 'private', mine: false, locked: true, createdBy: MEMBER.id },
    ]);
  });

  test('while private: the owner cannot rename or privately-read, but CAN force-publish', async () => {
    const rename = await handleCanvasesApi(
      new Request('https://x/api/canvases/x', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Stolen' }),
      }),
      database,
      OWNER,
      canvasId,
    );
    expect(rename.status).toBe(403);
    expect((await patchVis(OWNER, 'workspace')).status).toBe(200);
    expect((await list(OWNER))[0]).toMatchObject({ visibility: 'workspace' });
  });

  test('the owner may never privatize someone else’s canvas (403); a plain member gets 404 on a hidden one', async () => {
    expect((await patchVis(OWNER, 'private')).status).toBe(403);
    await patchVis(MEMBER, 'private');
    const STRANGER_MEMBER = { id: 'user_vis_third' };
    await db.insert(schema.user).values({ id: STRANGER_MEMBER.id, name: 'third', email: 'third@example.com' });
    await db
      .insert(schema.workspaceMembers)
      .values({ id: 'wm_vis3', workspaceId: cookie.slice('cs_workspace='.length), userId: STRANGER_MEMBER.id });
    expect((await patchVis(STRANGER_MEMBER, 'workspace')).status).toBe(404);
    expect(await list(STRANGER_MEMBER)).toEqual([]);
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

  test('asks the PUBLIC edge Better Auth for a magic link — no password, no public signup (#179: invite-only)', async () => {
    const html = await renderLogin().text();
    expect(html).toContain('/api/auth/sign-in/magic-link');
    // Passwordless: the password credential is gone, so neither the password
    // sign-in nor any signup endpoint may appear.
    expect(html).not.toContain('/api/auth/sign-in/email');
    expect(html).not.toContain('/api/auth/sign-up/email');
    expect(html).not.toContain('type=password');
  });

  test('reveals nothing about whether the address has an account', async () => {
    const html = await renderLogin().text();
    // The confirmation is conditional prose, not a claim that mail was sent — an
    // uninvited address must not be able to tell itself apart from an invited one.
    expect(html).toContain('has access');
  });

  test('is the Better Auth login, NOT the deleted cs_gate ?key= page', async () => {
    const html = await renderLogin().text();
    expect(html).not.toContain('?key=');
    expect(html).not.toContain('cs_gate');
  });

  test('continues an interrupted OAuth authorize after sign-in (#177: /mcp/authorize redirected here with its query)', async () => {
    const html = await renderLogin().text();
    // The client-side success handler must bounce back to the authorize endpoint,
    // carrying the original OAuth query, instead of always landing on '/'.
    expect(html).toContain('/api/auth/mcp/authorize');
    expect(html).toContain('client_id');
    // Passwordless moves the session mint to a LATER request (the emailed link), so
    // the continuation can no longer be read off location.search on return — it must
    // be handed to Better Auth as callbackURL and survive the mail hop.
    expect(html).toContain('callbackURL');
  });
});

// Canvas pairing: the Inbox attach panel lists the CONVERSATION's workspace's canvases, not
// the rail's cs_workspace cookie — GET accepts an explicit ?workspace= override, ownership-
// checked exactly like the cookie. Mutations never honor it (cookie-scoped as before).
describe('handleCanvasesApi — GET ?workspace= override (the Inbox attach panel)', () => {
  test('lists the named workspace regardless of the cookie', async () => {
    const ws = await createWorkspace(database, { name: 'PairWs', ownerUserId: USER.id });
    await canvasRegistry.create(database, { workspaceId: ws.id, name: 'PairBoard' });

    const res = await handleCanvasesApi(
      new Request(`https://x/api/canvases?workspace=${ws.id}`), // no cookie at all
      database,
      USER,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(ws.id);
    expect(body.canvases.map((c: { name: string }) => c.name)).toContain('PairBoard');
  });

  test('a non-owned ?workspace= is 404 (same gate as the cookie path)', async () => {
    const res = await handleCanvasesApi(
      new Request('https://x/api/canvases?workspace=ws_not_mine'),
      database,
      USER,
    );
    expect(res.status).toBe(404);
  });

  test('POST ignores ?workspace= — mutations stay cookie-scoped', async () => {
    const ws = await createWorkspace(database, { name: 'MutWs', ownerUserId: USER.id });
    const res = await handleCanvasesApi(
      new Request(`https://x/api/canvases?workspace=${ws.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Sneak' }),
      }),
      database,
      USER,
    );
    expect(res.status).toBe(201);
    const made = await readJson(res);
    // Created in the COOKIE scope (default), not the query-named workspace.
    const inWs = await readJson(await handleCanvasesApi(new Request(`https://x/api/canvases?workspace=${ws.id}`), database, USER));
    expect(inWs.canvases.map((c: { id: string }) => c.id)).not.toContain(made.id);
  });
});

// The picker's hand-arranged order (a JSON array of canvas ids on the workspace). Stored
// whole rather than as a sort column per canvas, because the legacy `default` canvas has
// no registry row and a per-row column could never place it.
describe('handleCanvasesApi — the canvas picker order', () => {
  const get = () => handleCanvasesApi(new Request('https://x/api/canvases'), database, USER);
  const put = (order: string[]) =>
    handleCanvasesApi(
      new Request('https://x/api/canvases', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order }),
      }),
      database,
      USER,
    );

  test('a workspace that has never reordered reports no order at all', async () => {
    // Which is what makes the list read as `created_at` ascending, exactly as before.
    expect((await readJson(await get())).canvasOrder).toEqual([]);
  });

  test('the order round-trips, and rides along with the list it orders', async () => {
    expect((await put(['default', 'cv_b', 'cv_a'])).status).toBe(200);
    const body = await readJson(await get());
    // One round trip: no window in which the rows have arrived but their arrangement has not.
    expect(body.canvasOrder).toEqual(['default', 'cv_b', 'cv_a']);
    expect(Array.isArray(body.canvases)).toBe(true);
  });

  test('`default` may be placed like any other canvas', async () => {
    // It has no registry row — the whole reason the order is an id array — so the API must
    // not validate ids against the registry.
    await put(['cv_a', 'default']);
    expect((await readJson(await get())).canvasOrder).toEqual(['cv_a', 'default']);
  });

  test('a malformed order is refused rather than stored', async () => {
    await put(['cv_a']);
    expect((await put([123 as never])).status).toBe(400);
    expect((await readJson(await get())).canvasOrder).toEqual(['cv_a']);
  });
});
