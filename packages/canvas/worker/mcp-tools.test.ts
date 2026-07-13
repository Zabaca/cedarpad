import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { addWorkspaceMember, createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { buildMcpTools } from './mcp-tools.ts';

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
const tools = buildMcpTools({
  db: database,
  userId: 'u_1',
  proxySend: async (workspaceId, chatId, message, canvasId) => {
    sends.push({ workspaceId, chatId, message, canvasId });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  },
  proxySkill: async (workspaceId, name, input) => {
    skillUploads.push({ workspaceId, name, files: input.files.length });
    return new Response(JSON.stringify({ ok: true, skill: name }), { status: 200 });
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

  test("read_conversation never returns another user's conversation", async () => {
    await conversations.create(database, {
      sessionId: 's_2',
      userId: 'u_2',
      workspaceId: OTHER_WS,
      ownerRef: 'mcp_theirs',
    } as never);
    expect((await tools.readConversation({ chat_id: 'mcp_theirs' })).status).toBe('starting');
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

  test('list_inbox lists the workspace’s conversations for the user', async () => {
    const res = await tools.listInbox({ workspace_id: WS });
    expect(res.items.map((i) => i.chat_id)).toContain('mcp_test_read');
    expect(res.items.every((i) => i.workspace_id === WS)).toBe(true);
  });
});
