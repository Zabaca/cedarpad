import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { addWorkspaceMember, createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { buildMcpTools, EditComponentInput, WriteComponentInput } from './mcp-tools.ts';
import { d1RecordStore } from './record-store.ts';

// In-memory DB built from the real migrations (mirrors shell.test.ts).
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

let skillUploads: Array<{ workspaceId: string; name: string; files: number }> = [];
let bridgeCalls: Array<{ workspaceId: string; path: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
// Canned bridge responses by path — set per test; unset paths 404. A key may be prefixed
// with a method ("PUT /api/components/X") when one path answers differently per verb, which
// a read-modify-write tool needs; a bare path still matches any method.
let bridgeResponses: Record<string, unknown> = {};
const tools = buildMcpTools({
  db: database,
  userId: 'u_1',
  proxySkill: async (workspaceId, name, input) => {
    skillUploads.push({ workspaceId, name, files: input.files.length });
    return new Response(JSON.stringify({ ok: true, skill: name }), { status: 200 });
  },
  proxyBridge: async (workspaceId, path, init) => {
    bridgeCalls.push({ workspaceId, path, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const canned = bridgeResponses[`${init?.method ?? 'GET'} ${path}`] ?? bridgeResponses[path];
    return canned === undefined
      ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      : new Response(JSON.stringify(canned), { status: 200 });
  },
});

let WS = '';
let OTHER_WS = '';

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const id of ['u_1', 'u_2']) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
  WS = (await createWorkspace(database, { name: 'mine', ownerUserId: 'u_1' })).id;
  OTHER_WS = (await createWorkspace(database, { name: 'theirs', ownerUserId: 'u_2' })).id;
});

describe('mcp tools — every read/act is scoped to the token user’s workspaces (#177)', () => {
  test('list_workspaces returns owned and member-of with roles, never a stranger’s', async () => {
    const shared = await createWorkspace(database, { name: 'shared', ownerUserId: 'u_2' });
    await addWorkspaceMember(database, { workspaceId: shared.id, userId: 'u_1' });

    const res = await tools.listWorkspaces();
    const byId = Object.fromEntries(res.workspaces.map((w) => [w.id, w.role]));
    expect(byId[WS]).toBe('owner');
    expect(byId[shared.id]).toBe('member');
    expect(byId[OTHER_WS]).toBeUndefined();
  });

  test('list_canvases is access-checked: own workspace lists, a stranger’s errors', async () => {
    await canvasRegistry.create(database, { workspaceId: WS, name: 'Roadmap' });
    const ok = await tools.listCanvases({ workspace_id: WS });
    expect(ok.canvases.map((c) => c.name)).toContain('Roadmap');

    await expect(tools.listCanvases({ workspace_id: OTHER_WS })).rejects.toThrow(/not found/);
  });

  test('upload_skill is access-checked and proxies to the bridge (single writer of the tree)', async () => {
    skillUploads = [];
    const res = await tools.uploadSkill({
      workspace_id: WS,
      name: 'yc-critique',
      files: [{ path: 'SKILL.md', content: '---\nname: yc-critique\n---\n' }],
    });
    expect(res.skill).toBe('yc-critique');
    expect(skillUploads).toEqual([{ workspaceId: WS, name: 'yc-critique', files: 1 }]);

    await expect(
      tools.uploadSkill({ workspace_id: OTHER_WS, name: 'x', files: [{ path: 'SKILL.md', content: 'x' }] }),
    ).rejects.toThrow(/not found/);
    expect(skillUploads).toHaveLength(1);
  });

  // MCP full access: direct reads (canvas, transcript) and the component library, all
  // proxied to the workspace's bridge and access-checked exactly like the relay tools.
  test('read_canvas proxies GET /api/canvas scoped to a workspace canvas; a stranger’s workspace or an unknown canvas never proxies', async () => {
    bridgeCalls = [];
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'ReadMe' });
    bridgeResponses = { '/api/canvas': { version: 3, shapes: [{ id: 's1' }] } };

    const res = await tools.readCanvas({ workspace_id: WS, canvas_id: board.id });
    expect(res).toEqual({ version: 3, shapes: [{ id: 's1' }] });
    expect(bridgeCalls).toEqual([{ workspaceId: WS, path: '/api/canvas', method: 'GET', headers: { 'x-canvas-id': board.id }, body: undefined }]);

    // No canvas_id → the workspace's default canvas (no header).
    bridgeCalls = [];
    await tools.readCanvas({ workspace_id: WS });
    expect(bridgeCalls[0]?.headers).toEqual({});

    await expect(tools.readCanvas({ workspace_id: OTHER_WS })).rejects.toThrow(/not found/);
    await expect(tools.readCanvas({ workspace_id: WS, canvas_id: 'cv_ghost' })).rejects.toThrow(/canvas/);
  });

  test('read_canvas narrows to one page at the BRIDGE, so the whole canvas never crosses this hop', async () => {
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Paged' });
    bridgeCalls = [];
    bridgeResponses = { '/api/canvas?page=page%3Atwo': { version: 1, shapes: [], pages: [] } };

    await tools.readCanvas({ workspace_id: WS, canvas_id: board.id, page: 'page:two' });
    // Filtering after the response arrives would still drag every shape across this hop —
    // and the hop is exactly what the MCP response limit measures.
    expect(bridgeCalls[0]?.path).toBe('/api/canvas?page=page%3Atwo');

    // No page named: the request is byte-identical to what it always was.
    bridgeCalls = [];
    bridgeResponses = { '/api/canvas': { version: 1, shapes: [] } };
    await tools.readCanvas({ workspace_id: WS, canvas_id: board.id });
    expect(bridgeCalls[0]?.path).toBe('/api/canvas');
  });

  test('select_page resolves the name at the EDGE and posts the id, stamped with the token user as viewer', async () => {
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Nav' });
    bridgeResponses = {
      '/api/canvas': { version: 3, shapes: [], pages: [{ id: 'page:page', name: 'Page 1' }, { id: 'page:two', name: 'Roadmap' }] },
      '/api/canvas/select-page': { asked: 1 },
    };
    bridgeCalls = [];

    expect(await tools.selectPage({ workspace_id: WS, canvas_id: board.id, page: 'Roadmap' })).toEqual({ page_id: 'page:two', asked: 1 });

    const post = bridgeCalls.find((c) => c.path === '/api/canvas/select-page');
    // The bridge is handed an ID — a page NAME never reaches it.
    expect(post?.body).toEqual({ pageId: 'page:two' });
    // The viewer is the OAuth token's user: this proxy is a synthetic request, so the
    // edge's browser-path stamping never ran and the tool must supply it itself.
    expect(post?.headers['x-canvas-viewer']).toBe('u_1');
  });

  test('select_page refuses an unknown page instead of moving the viewer somewhere arbitrary', async () => {
    bridgeResponses = { '/api/canvas': { version: 3, shapes: [], pages: [{ id: 'page:page', name: 'Page 1' }] } };
    bridgeCalls = [];
    await expect(tools.selectPage({ workspace_id: WS, page: 'Sprint 12' })).rejects.toThrow(/Sprint 12/);
    expect(bridgeCalls.some((c) => c.path === '/api/canvas/select-page')).toBe(false);
  });

  test('select_page reports asked: 0 rather than dressing up "nobody was looking" as success', async () => {
    bridgeResponses = {
      '/api/canvas': { version: 3, shapes: [], pages: [{ id: 'page:page', name: 'Page 1' }, { id: 'page:two', name: 'Roadmap' }] },
      '/api/canvas/select-page': { asked: 0 },
    };
    expect(await tools.selectPage({ workspace_id: WS, page: 'page:two' })).toEqual({ page_id: 'page:two', asked: 0 });
  });

  test('read_image proxies the shape id to the canvas the token user can reach and returns the pixels', async () => {
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Shots' });
    bridgeResponses = { '/api/canvas/image?id=shape%3Apic': { data: 'iVBOR', mimeType: 'image/png' } };
    bridgeCalls = [];

    expect(await tools.readImage({ workspace_id: WS, canvas_id: board.id, id: 'shape:pic' })).toEqual({ data: 'iVBOR', mimeType: 'image/png' });
    expect(bridgeCalls[0]?.headers['x-canvas-id']).toBe(board.id);
  });

  test('read_image refuses another workspace’s canvas before the bridge is asked', async () => {
    const theirs = await canvasRegistry.create(database, { workspaceId: OTHER_WS, name: 'Theirs' });
    bridgeCalls = [];
    await expect(tools.readImage({ workspace_id: WS, canvas_id: theirs.id, id: 'shape:pic' })).rejects.toThrow(/canvas not found/);
    expect(bridgeCalls).toEqual([]);
  });

  test('view_canvas resolves a page NAME at the edge and asks the bridge for that page id', async () => {
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Look' });
    bridgeResponses = {
      '/api/canvas': { version: 3, shapes: [], pages: [{ id: 'page:page', name: 'Page 1' }, { id: 'page:two', name: 'Roadmap' }] },
      '/api/canvas/view': { url: 'data:image/png;base64,AAAA' },
    };
    bridgeCalls = [];

    expect(await tools.viewCanvas({ workspace_id: WS, canvas_id: board.id, page: 'Roadmap' })).toEqual({ data: 'AAAA', mimeType: 'image/png' });
    const post = bridgeCalls.find((c) => c.path === '/api/canvas/view');
    expect(post?.body).toEqual({ pageId: 'page:two' });
    expect(post?.headers['x-canvas-id']).toBe(board.id);
  });

  test('view_canvas with ids posts them as-is, without reading the canvas first', async () => {
    bridgeResponses = { '/api/canvas/view': { url: 'data:image/png;base64,BBBB' } };
    bridgeCalls = [];
    expect(await tools.viewCanvas({ workspace_id: WS, ids: ['shape:frame'], page: 'Roadmap' })).toEqual({ data: 'BBBB', mimeType: 'image/png' });
    // ids win over page, and a busy canvas is never read whole just to check them.
    expect(bridgeCalls.map((c) => c.path)).toEqual(['/api/canvas/view']);
    expect(bridgeCalls[0]?.body).toEqual({ ids: ['shape:frame'] });
  });

  test('view_canvas without a page skips the canvas read, and "no tab answered" comes back as null', async () => {
    bridgeResponses = { '/api/canvas/view': { url: null } };
    bridgeCalls = [];
    expect(await tools.viewCanvas({ workspace_id: WS })).toBeNull();
    expect(bridgeCalls.map((c) => c.path)).toEqual(['/api/canvas/view']);
    expect(bridgeCalls[0]?.body).toEqual({});
  });

  // ADR-0022 / PRD #354 story 29: the LISTING is answered at the edge from Records plus the
  // bundled platform manifest. An outside agent browsing the library must not cold-boot (and
  // bill) a container to read a few kilobytes of names — so this tool makes no bridge call
  // at all, which is what the empty `bridgeCalls` below states.
  test('list_components is answered at the edge — Records plus the platform manifest, with tier labels, no container', async () => {
    bridgeCalls = [];
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'CatalogBoard' });
    await d1RecordStore(database).put({
      workspaceId: WS,
      canvasId: board.id,
      name: 'OwnCard',
      kind: 'component',
      source: '// This canvas.\n',
      updatedBy: 'u_1',
    });

    const res = await tools.listComponents({ workspace_id: WS, canvas_id: board.id });
    expect(res.details).toContainEqual({ name: 'OwnCard', description: 'This canvas.', tier: 'own' });
    expect(res.details.find((d) => d.name === 'MarkdownCard')?.tier).toBe('base');
    expect(res.components).toEqual(res.details.map((d) => d.name));
    expect(bridgeCalls).toEqual([]);

    await expect(tools.listComponents({ workspace_id: OTHER_WS })).rejects.toThrow(/not found/);
    await expect(tools.listComponents({ workspace_id: WS, canvas_id: 'cv_ghost' })).rejects.toThrow(/canvas/);
  });

  test('read/write component proxy the bridge component routes, canvas-scoped and access-checked', async () => {
    bridgeCalls = [];
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'ComponentBoard' });
    bridgeResponses = {
      '/api/components/KpiCard': { module: 'KpiCard', source: 'export default …' },
    };

    // Numbered even for a one-line file — see the read tests below for why there is only ever
    // the one shape.
    expect(await tools.readComponent({ workspace_id: WS, module: 'KpiCard' })).toEqual({
      module: 'KpiCard',
      offset: 1,
      limit: 1,
      lines: 1,
      source: '     1\texport default …',
    });

    bridgeResponses['/api/components/NewCard'] = { ok: true, module: 'NewCard', reloaded: 1 };
    const write = await tools.writeComponent({
      workspace_id: WS,
      canvas_id: board.id,
      module: 'NewCard',
      source: 'export default function NewCard(){return null}',
    });
    expect(write).toEqual({ ok: true, module: 'NewCard', reloaded: 1 });
    expect(bridgeCalls.at(-1)).toMatchObject({
      workspaceId: WS,
      path: '/api/components/NewCard',
      method: 'PUT',
      headers: { 'x-canvas-id': board.id },
      body: { source: 'export default function NewCard(){return null}' },
    });

    // A bridge error surfaces as a thrown error, and access is workspace-checked.
    await expect(tools.readComponent({ workspace_id: WS, module: 'ZzGhost' })).rejects.toThrow(/404|not found/);
    await expect(tools.readComponent({ workspace_id: OTHER_WS, module: 'KpiCard' })).rejects.toThrow(/not found/);
  });

  // ── Read a window, edit by anchor (CEDA-OB5DX6) ─────────────────────────────────
  // The loop Claude Code runs for a small change: read a WINDOW of a file, then edit the
  // text you just read — never re-supply the whole module. Driven here through the tool
  // seam: what the read returns, and what the edit sends to the bridge.

  /** Six lines, trailing newline. Every line number expected below is counted off THIS. */
  const COUNTER_SOURCE =
    [
      "import { useState } from 'react';",
      '',
      'export default function Counter() {',
      '  const [n, setN] = useState(0);',
      '  return <button onClick={() => setN(n + 1)}>{n}</button>;',
      '}',
    ].join('\n') + '\n';

  test('read_component takes an offset/limit window and returns just those lines, numbered', async () => {
    bridgeResponses = { '/api/components/Counter': { module: 'Counter', source: COUNTER_SOURCE } };

    expect(await tools.readComponent({ workspace_id: WS, module: 'Counter', offset: 3, limit: 2 })).toEqual({
      module: 'Counter',
      offset: 3,
      limit: 2,
      lines: 6,
      source: '     3\texport default function Counter() {\n     4\t  const [n, setN] = useState(0);',
    });

    // Nothing asked for → the WHOLE file, still numbered and still reporting its length.
    // One shape, always: an agent that never has to work out which mode it is looking at
    // never pastes a line number into an anchor, and can always tell it saw the whole file.
    expect(await tools.readComponent({ workspace_id: WS, module: 'Counter' })).toEqual({
      module: 'Counter',
      offset: 1,
      limit: 6,
      lines: 6,
      source: [
        "     1\timport { useState } from 'react';",
        '     2\t',
        '     3\texport default function Counter() {',
        '     4\t  const [n, setN] = useState(0);',
        '     5\t  return <button onClick={() => setN(n + 1)}>{n}</button>;',
        '     6\t}',
      ].join('\n'),
    });
  });

  test('read_component clamps a window that overruns the file, and refuses one that starts past it', async () => {
    bridgeResponses = { '/api/components/Counter': { module: 'Counter', source: COUNTER_SOURCE } };

    // Overrunning the end is ordinary paging — it stops at the last line rather than erroring.
    expect(await tools.readComponent({ workspace_id: WS, module: 'Counter', offset: 5, limit: 99 })).toEqual({
      module: 'Counter',
      offset: 5,
      limit: 2,
      lines: 6,
      source: '     5\t  return <button onClick={() => setN(n + 1)}>{n}</button>;\n     6\t}',
    });

    // Starting past the end is a mistake, not a page: an empty window looks like an empty
    // file, and an agent that believes that will overwrite one. Say how long the file is.
    await expect(tools.readComponent({ workspace_id: WS, module: 'Counter', offset: 9 })).rejects.toThrow(
      /offset 9 .*past the end.*6 lines/,
    );
  });

  test('edit_component anchors on TEXT and proxies the bridge PATCH in one hop', async () => {
    bridgeCalls = [];
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'EditBoard' });
    bridgeResponses = { 'PATCH /api/components/Counter': { ok: true, module: 'Counter', reloaded: 2 } };

    const res = await tools.editComponent({
      workspace_id: WS,
      canvas_id: board.id,
      module: 'Counter',
      old_string: 'useState(0)',
      new_string: 'useState(10)',
    });
    expect(res).toEqual({ ok: true, module: 'Counter', reloaded: 2 });

    // ONE call: the container reads and rewrites the file itself, so the edge never fetches
    // the source first. The anchor travels, not the file — which is the whole point.
    expect(bridgeCalls).toEqual([
      {
        workspaceId: WS,
        path: '/api/components/Counter',
        method: 'PATCH',
        headers: { 'x-canvas-id': board.id },
        body: { old_string: 'useState(0)', new_string: 'useState(10)' },
      },
    ]);

    // replace_all rides along only when asked for, so the bridge's optional stays optional.
    bridgeCalls = [];
    await tools.editComponent({
      workspace_id: WS,
      canvas_id: board.id,
      module: 'Counter',
      old_string: 'n',
      new_string: 'count',
      replace_all: true,
    });
    expect(bridgeCalls.at(-1)?.body).toEqual({ old_string: 'n', new_string: 'count', replace_all: true });

    // The bridge's refusal is the tool's refusal: a missing anchor must not read as a no-op.
    bridgeResponses = {};
    await expect(
      tools.editComponent({ workspace_id: WS, canvas_id: board.id, module: 'Counter', old_string: 'ghost', new_string: 'x' }),
    ).rejects.toThrow(/PATCH .*failed/);

    // Access-checked like every other canvas tool.
    await expect(
      tools.editComponent({ workspace_id: OTHER_WS, canvas_id: board.id, module: 'Counter', old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow(/not found/);
  });

  test('edit_component is a write: canvas_id is mandatory, and an empty anchor is refused', async () => {
    // Same rule as write_component — a write that lands in the default canvas by omission is
    // invisible until something later fails to resolve it.
    expect(EditComponentInput.safeParse({ workspace_id: WS, module: 'C', old_string: 'a', new_string: 'b' }).success).toBe(false);
    // An empty anchor matches at every position and therefore names nothing.
    expect(EditComponentInput.safeParse({ workspace_id: WS, canvas_id: 'cv', module: 'C', old_string: '', new_string: 'b' }).success).toBe(
      false,
    );
    // Deleting the anchor outright is legitimate, so new_string may be empty.
    expect(EditComponentInput.safeParse({ workspace_id: WS, canvas_id: 'cv', module: 'C', old_string: 'a', new_string: '' }).success).toBe(
      true,
    );
  });
  test('write_component requires canvas_id — an omitted or unregistered one is rejected before it can land in the wrong canvas', async () => {
    // Schema level: the MCP protocol boundary rejects a missing canvas_id outright (unlike
    // read_component/list_components, which default to the workspace's default canvas).
    expect(WriteComponentInput.safeParse({ workspace_id: WS, module: 'NewCard', source: 'x' }).success).toBe(false);

    // ...and a write advertises NO line window: `.shape` is what the MCP client is shown as
    // this tool's input schema, so read_component's offset/limit leaking in would offer a
    // knob write_component ignores.
    expect(Object.keys(WriteComponentInput.shape)).not.toContain('offset');

    // Tool level: a canvas_id that isn't registered to this workspace is rejected too (same
    // guard read_canvas already has for an unknown canvas).
    await expect(
      tools.writeComponent({ workspace_id: WS, canvas_id: 'cv_ghost', module: 'NewCard', source: 'x' }),
    ).rejects.toThrow(/canvas/);
  });

  test('write_data proxies the data-file route, validates the name at the edge, access-checked', async () => {
    bridgeCalls = [];
    bridgeResponses = { '/api/components/data/sales.json': { ok: true, name: 'sales.json', reloaded: 1 } };

    const res = await tools.writeData({ workspace_id: WS, name: 'sales.json', source: '{"rows":[1]}' });
    expect(res).toEqual({ ok: true, name: 'sales.json', reloaded: 1 });
    expect(bridgeCalls.at(-1)).toMatchObject({
      workspaceId: WS,
      path: '/api/components/data/sales.json',
      method: 'PUT',
      body: { source: '{"rows":[1]}' },
    });

    await expect(tools.writeData({ workspace_id: OTHER_WS, name: 'sales.json', source: '{}' })).rejects.toThrow(/not found/);
    expect(bridgeCalls.length).toBe(1); // the access check never proxied
  });

  test('create/update/delete shapes and place_component proxy the mutation routes, canvas-scoped and access-checked', async () => {
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Mutable' });
    bridgeResponses = {
      '/api/canvas/shapes/create': { text: 'Created 1 shape(s)' },
      '/api/canvas/shapes/update': { text: 'Updated 1 shape(s).' },
      '/api/canvas/delete': { version: 9 },
      '/api/components/place': { text: 'Placed <KpiCard> as cmp_1, 360×260.' },
    };
    bridgeCalls = [];

    await tools.createShapes({ workspace_id: WS, canvas_id: board.id, shapes: [{ type: 'rectangle', x: 1, y: 2 }] });
    await tools.updateShapes({ workspace_id: WS, canvas_id: board.id, shapes: [{ id: 's1', text: 'renamed' }] });
    await tools.deleteShapes({ workspace_id: WS, canvas_id: board.id, ids: ['s1'] });
    await tools.placeComponent({ workspace_id: WS, canvas_id: board.id, module: 'KpiCard', x: 10, y: 20, data: { n: 1 } });

    expect(bridgeCalls.map((c) => [c.path, c.method])).toEqual([
      ['/api/canvas/shapes/create', 'POST'],
      ['/api/canvas/shapes/update', 'POST'],
      ['/api/canvas/delete', 'POST'],
      ['/api/components/place', 'POST'],
    ]);
    expect(bridgeCalls.every((c) => c.headers['x-canvas-id'] === board.id)).toBe(true);
    expect(bridgeCalls[0]?.body).toEqual({ shapes: [{ type: 'rectangle', x: 1, y: 2 }] });
    expect(bridgeCalls[2]?.body).toEqual({ ids: ['s1'] });
    expect(bridgeCalls[3]?.body).toEqual({ module: 'KpiCard', x: 10, y: 20, data: { n: 1 } });

    bridgeCalls = [];
    await expect(tools.createShapes({ workspace_id: OTHER_WS, shapes: [{ type: 'text' }] })).rejects.toThrow(/not found/);
    await expect(tools.placeComponent({ workspace_id: WS, canvas_id: 'cv_ghost', module: 'X', x: 0, y: 0 })).rejects.toThrow(/canvas/);
    expect(bridgeCalls).toEqual([]);
  });

  test('call_component proxies the call route with only id/command/args, canvas-scoped and access-checked', async () => {
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Commands' });
    bridgeResponses = { '/api/components/call': { text: 'Ran Kanban.addCard on cmp_1.' } };
    bridgeCalls = [];

    await tools.callComponent({ workspace_id: WS, canvas_id: board.id, id: 'cmp_1', command: 'addCard', args: { column: 'todo', title: 'x' } });

    expect(bridgeCalls.map((c) => [c.path, c.method])).toEqual([['/api/components/call', 'POST']]);
    expect(bridgeCalls[0]?.headers['x-canvas-id']).toBe(board.id);
    expect(bridgeCalls[0]?.body).toEqual({ id: 'cmp_1', command: 'addCard', args: { column: 'todo', title: 'x' } });

    bridgeCalls = [];
    await expect(tools.callComponent({ workspace_id: OTHER_WS, id: 'cmp_1', command: 'addCard', args: {} })).rejects.toThrow(/not found/);
    expect(bridgeCalls).toEqual([]);
  });

});

describe('create_canvas — the same registry create the shell route uses, access-checked', () => {
  test('creates a canvas in an owned workspace; it shows up in list_canvases', async () => {
    const res = await tools.createCanvas({ workspace_id: WS, name: 'Roadmap' });
    expect(res.id).toMatch(/^cv_/);
    expect(res).toEqual({ id: res.id, name: 'Roadmap', workspace_id: WS });
    const listed = await tools.listCanvases({ workspace_id: WS });
    expect(listed.canvases.some((c) => c.id === res.id && c.name === 'Roadmap')).toBe(true);
  });

  test('never creates in a stranger’s workspace', async () => {
    await expect(tools.createCanvas({ workspace_id: OTHER_WS, name: 'Sneaky' })).rejects.toThrow(/workspace not found/);
  });
});
