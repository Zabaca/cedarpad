import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { addWorkspaceMember, createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { buildMcpTools, RunDevAgentInput, WriteComponentInput } from './mcp-tools.ts';
import { NOTEBOOK_TOOL_SPECS } from '../web-poc/lib/contract/notebook-tools.ts';
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

let sends: Array<{ workspaceId: string; chatId: string; message: string; canvasId?: string }> = [];
let skillUploads: Array<{ workspaceId: string; name: string; files: number }> = [];
let bridgeCalls: Array<{ workspaceId: string; path: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
// Canned bridge responses by path — set per test; unset paths 404.
let bridgeResponses: Record<string, unknown> = {};
/** Which workspaces the tools rang the events hub for (#383). */
const rung: string[] = [];
const tools = buildMcpTools({
  db: database,
  userId: 'u_1',
  notify: async (workspaceId) => void rung.push(workspaceId),
  proxySend: async (workspaceId, chatId, message, canvasId) => {
    sends.push({ workspaceId, chatId, message, canvasId });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  },
  proxySkill: async (workspaceId, name, input) => {
    skillUploads.push({ workspaceId, name, files: input.files.length });
    return new Response(JSON.stringify({ ok: true, skill: name }), { status: 200 });
  },
  proxyBridge: async (workspaceId, path, init) => {
    bridgeCalls.push({ workspaceId, path, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const canned = bridgeResponses[path];
    return canned === undefined
      ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      : new Response(JSON.stringify(canned), { status: 200 });
  },
  kickDevAgent: async () => Response.json({ chatId: 'dev-agent-run-x', joined: false }, { status: 202 }),
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

  test('send_message mints a chat id, proxies the send, and returns the poll handle', async () => {
    sends = [];
    const res = await tools.sendMessage({ workspace_id: WS, message: 'hello agent' });
    expect(res.chat_id.startsWith('mcp_')).toBe(true);
    expect(res.status).toBe('running');
    expect(sends).toEqual([{ workspaceId: WS, chatId: res.chat_id, message: 'hello agent', canvasId: undefined }]);
  });

  test('send_message to a stranger’s workspace never proxies', async () => {
    sends = [];
    await expect(tools.sendMessage({ workspace_id: OTHER_WS, message: 'nope' })).rejects.toThrow(/not found/);
    expect(sends).toEqual([]);
  });

  test('read_conversation finds the row by the chat handle once row-at-start lands; before that it reports starting', async () => {
    const chatId = 'mcp_test_read';
    expect((await tools.readConversation({ chat_id: chatId })).status).toBe('starting');

    await conversations.create(database, {
      sessionId: 's_1',
      userId: 'u_1',
      workspaceId: WS,
      ownerRef: chatId,
      summary: 'hello agent',
      lastMessagePreview: 'the reply text',
    } as never);
    const found = await tools.readConversation({ chat_id: chatId });
    expect(found.status).toBe('open');
    expect(found.last_message_preview).toBe('the reply text');
    expect(found.workspace_id).toBe(WS);
  });

  test("read_conversation never returns a conversation from a workspace the user can't access", async () => {
    await conversations.create(database, {
      sessionId: 's_2',
      userId: 'u_2',
      workspaceId: OTHER_WS,
      ownerRef: 'mcp_theirs',
    } as never);
    expect((await tools.readConversation({ chat_id: 'mcp_theirs' })).status).toBe('starting');
  });

  test('the inbox is workspace-shared: a member reads (and replies to) a conversation another member created', async () => {
    // u_2 creates a row in WS (u_1's workspace — imagine u_2 was invited); u_1 still sees it.
    await conversations.create(database, {
      sessionId: 's_shared',
      userId: 'u_2',
      workspaceId: WS,
      ownerRef: 'mcp_shared',
      summary: 'their session',
    } as never);
    const read = await tools.readConversation({ chat_id: 'mcp_shared' });
    expect(read.status).toBe('open');

    sends = [];
    const res = await tools.sendMessage({ workspace_id: WS, message: 'joining in', chat_id: 'mcp_shared' });
    expect(res.chat_id).toBe('mcp_shared');
    expect(sends).toHaveLength(1);
  });

  test('send_message with an existing chat_id replies into that conversation (same workspace, chat kind only)', async () => {
    sends = [];
    const chatId = 'mcp_test_read'; // created above, kind chat, WS, u_1
    const res = await tools.sendMessage({ workspace_id: WS, message: 'follow-up', chat_id: chatId });
    expect(res.chat_id).toBe(chatId);
    expect(sends).toHaveLength(1);

    // a dev-agent conversation is not reachable through this tool
    await conversations.create(database, {
      sessionId: 's_3',
      userId: 'u_1',
      workspaceId: WS,
      ownerRef: 'mcp_devagent',
      kind: 'dev-agent',
    } as never);
    await expect(tools.sendMessage({ workspace_id: WS, message: 'x', chat_id: 'mcp_devagent' })).rejects.toThrow(/chat/);
  });

  test("send_message continuing a canvas-paired conversation addresses that canvas (the agent's canvas tools bind to it)", async () => {
    sends = [];
    const board = await canvasRegistry.create(database, { workspaceId: WS, name: 'Board' });
    await conversations.create(database, {
      sessionId: 's_paired',
      userId: 'u_1',
      workspaceId: WS,
      ownerRef: 'mcp_paired',
      canvasId: board.id,
    } as never);

    await tools.sendMessage({ workspace_id: WS, message: 'about the board', chat_id: 'mcp_paired' });
    expect(sends).toEqual([{ workspaceId: WS, chatId: 'mcp_paired', message: 'about the board', canvasId: board.id }]);

    // An explicit canvas_id wins over the pairing.
    sends = [];
    await tools.sendMessage({ workspace_id: WS, message: 'elsewhere', chat_id: 'mcp_paired', canvas_id: 'other_canvas' });
    expect(sends[0]?.canvasId).toBe('other_canvas');
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

  test('read_transcript restores the session (inbox open) then returns the full settled events — the user’s own conversations only', async () => {
    const chatId = 'mcp_full_transcript';
    const conv = await conversations.create(database, {
      sessionId: 's_full',
      userId: 'u_1',
      workspaceId: WS,
      ownerRef: chatId,
    } as never);
    bridgeResponses = {
      [`/api/inbox/${conv.id}/chat`]: { chatId: 'chat_resolved' },
      '/api/chat/chat_resolved/transcript': { events: [{ kind: 'text', text: 'the whole reply' }] },
    };
    bridgeCalls = [];

    const res = await tools.readTranscript({ chat_id: chatId });
    expect(res.chat_id).toBe(chatId);
    expect(res.events).toEqual([{ kind: 'text', text: 'the whole reply' }]);
    expect(bridgeCalls.map((c) => c.path)).toEqual([`/api/inbox/${conv.id}/chat`, '/api/chat/chat_resolved/transcript']);

    await expect(tools.readTranscript({ chat_id: 'mcp_theirs' })).rejects.toThrow(/not found/); // u_2's
    await expect(tools.readTranscript({ chat_id: 'mcp_ghost' })).rejects.toThrow(/not found/);
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
    expect(res.details.find((d) => d.name === 'KpiCard')?.tier).toBe('base');
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

    expect(await tools.readComponent({ workspace_id: WS, module: 'KpiCard' })).toEqual({ module: 'KpiCard', source: 'export default …' });

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

  test('write_component requires canvas_id — an omitted or unregistered one is rejected before it can land in the wrong canvas', async () => {
    // Schema level: the MCP protocol boundary rejects a missing canvas_id outright (unlike
    // read_component/list_components, which default to the workspace's default canvas).
    expect(WriteComponentInput.safeParse({ workspace_id: WS, module: 'NewCard', source: 'x' }).success).toBe(false);

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

  test('list_inbox lists the WHOLE workspace’s conversations (shared inbox), with assigned_to', async () => {
    const res = await tools.listInbox({ workspace_id: WS });
    expect(res.items.map((i) => i.chat_id)).toContain('mcp_test_read');
    // Another member's session shows too — the index is workspace-shared, not per-user.
    expect(res.items.map((i) => i.chat_id)).toContain('mcp_shared');
    expect(res.items.every((i) => i.workspace_id === WS)).toBe(true);
    expect(res.items.every((i) => 'assigned_to' in i)).toBe(true);
  });

  test('list_inbox filters by assignee: a user id, or "unassigned"', async () => {
    await conversations.create(database, {
      sessionId: 's_claimed',
      userId: 'u_1',
      workspaceId: WS,
      ownerRef: 'mcp_claimed',
      assignedTo: 'u_2',
    } as never);
    const theirs = await tools.listInbox({ workspace_id: WS, assigned: 'u_2' });
    expect(theirs.items.map((i) => i.chat_id)).toEqual(['mcp_claimed']);
    const unclaimed = await tools.listInbox({ workspace_id: WS, assigned: 'unassigned' });
    expect(unclaimed.items.map((i) => i.chat_id)).not.toContain('mcp_claimed');
  });
});

describe('assign_conversation — advisory assignment over MCP (full parity)', () => {
  test('assigns a member, clears with null, and the change is visible in reads', async () => {
    await conversations.create(database, {
      sessionId: 's_assign',
      userId: 'u_1',
      workspaceId: WS,
      ownerRef: 'mcp_assign',
    } as never);
    // u_2 must be a member of WS to be assignable.
    await addWorkspaceMember(database, { workspaceId: WS, userId: 'u_2' });

    const res = await tools.assignConversation({ chat_id: 'mcp_assign', user_id: 'u_2' });
    expect(res.assigned_to).toBe('u_2');
    expect((await tools.readConversation({ chat_id: 'mcp_assign' })).assigned_to).toBe('u_2');

    const cleared = await tools.assignConversation({ chat_id: 'mcp_assign', user_id: null });
    expect(cleared.assigned_to).toBeNull();
  });

  // #383: MCP is a third writer of the conversations table, alongside the edge routes and
  // the container's platform RPC. A claim made from an agent has to reach the badge like
  // one made from the Inbox does.
  test('an MCP assignment rings the conversation’s workspace events hub', async () => {
    rung.length = 0;
    await tools.assignConversation({ chat_id: 'mcp_assign', user_id: 'u_2' });
    expect(rung).toEqual([WS]);
  });

  test('a REFUSED assignment rings nothing', async () => {
    rung.length = 0;
    await expect(tools.assignConversation({ chat_id: 'mcp_assign', user_id: 'u_ghost' })).rejects.toThrow();
    expect(rung).toEqual([]);
  });

  test('a non-member target errors; a conversation outside the user’s workspaces errors', async () => {
    await expect(tools.assignConversation({ chat_id: 'mcp_assign', user_id: 'u_ghost' })).rejects.toThrow(/member/);
    await expect(tools.assignConversation({ chat_id: 'mcp_theirs', user_id: 'u_1' })).rejects.toThrow(/not found/);
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

describe('run_dev_agent — proxies the manual trigger; the bridge’s join answer comes back', () => {
  test('kicks with the optional repo/job and returns the bridge JSON', async () => {
    const kicks: Array<{ repo?: string; job?: string }> = [];
    const t = buildMcpTools({
      db: database,
      userId: 'u_1',
      proxySend: async () => new Response(null, { status: 202 }),
      proxySkill: async () => new Response(null, { status: 200 }),
      proxyBridge: async () => new Response(null, { status: 404 }),
      kickDevAgent: async (body) => {
        kicks.push(body);
        return Response.json({ chatId: 'dev-agent-run-x', joined: true }, { status: 202 });
      },
    });
    const res = await t.runDevAgent({ job: 'deps-audit' });
    expect(kicks).toEqual([{ job: 'deps-audit' }]);
    expect(res).toEqual({ chatId: 'dev-agent-run-x', joined: true });
  });

  test('a failed kick surfaces as an error (e.g. an unknown job’s 404)', async () => {
    const t = buildMcpTools({
      db: database,
      userId: 'u_1',
      proxySend: async () => new Response(null, { status: 202 }),
      proxySkill: async () => new Response(null, { status: 200 }),
      proxyBridge: async () => new Response(null, { status: 404 }),
      kickDevAgent: async () => Response.json({ error: 'job not found' }, { status: 404 }),
    });
    await expect(t.runDevAgent({ job: 'nope' })).rejects.toThrow(/404/);
  });

  // #100: one mechanism — the tool's schema itself requires a job (no built-in default task).
  test('the input schema requires `job`', () => {
    expect(RunDevAgentInput.safeParse({}).success).toBe(false);
    expect(RunDevAgentInput.safeParse({ repo: 'Zabaca/cedarpad' }).success).toBe(false);
    expect(RunDevAgentInput.safeParse({ job: 'deps-audit' }).success).toBe(true);
  });
});

// The Notebook over remote MCP (ADR-0024 / CEDA-X6OIAO). The tool BEHAVIOUR is covered at
// its own seam (`web-poc/worker/notebook-tools.test.ts`, on real D1); what matters here is
// the binding this surface supplies — a workspace the caller never names.
describe('notebook tools bind the token user’s workspace, never an argument', () => {
  test('records into the token user’s home workspace, and another user cannot read it', async () => {
    const mine = await tools.notebook();
    const { id } = await mine.recordObservation({ title: 'From MCP', body: 'recorded over the wire' });
    // u_1's oldest workspace is WS — the home workspace rule, not a parameter.
    expect((await mine.readObservation({ id })).observation.workspaceId).toBe(WS);

    // A stranger: their own user, their own workspace, no membership of WS.
    await db.insert(schema.user).values({ id: 'u_3', name: 'u_3', email: 'u_3@example.com' });
    await createWorkspace(database, { name: 'stranger', ownerUserId: 'u_3' });
    const theirs = await buildMcpTools({
      db: database,
      userId: 'u_3',
      notify: async () => {},
      proxySend: async () => new Response(null, { status: 202 }),
      proxySkill: async () => new Response(null, { status: 200 }),
      proxyBridge: async () => new Response(null, { status: 404 }),
      kickDevAgent: async () => new Response(null, { status: 202 }),
    }).notebook();
    await expect(theirs.readObservation({ id })).rejects.toThrow(/not found/);
  });

  test('no notebook tool advertises a workspace input', () => {
    for (const spec of NOTEBOOK_TOOL_SPECS) {
      expect(Object.keys(spec.schema.shape)).not.toContain('workspace_id');
      expect(Object.keys(spec.schema.shape)).not.toContain('workspaceId');
    }
  });
});
