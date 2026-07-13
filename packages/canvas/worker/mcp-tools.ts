import { z } from 'zod';
import { SkillName, UploadSkillInput as UploadSkillFiles } from '../shared/skills-wire.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { getWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';

// Inbound MCP tool logic (ADR-0013 train 3, #177) — pure, dependency-injected, no MCP SDK
// here (worker/mcp-server.ts wraps these as MCP tools; tests drive them directly). Every
// tool is scoped to the OAuth token's user: workspace access is owner-OR-member via
// `getWorkspace` (#181), and conversations are the user's own. The `chat_id` (the
// conversation row's `ownerRef`, minted at send) is the ONE conversation handle: send
// returns it, row-at-start indexes it, read polls it.

// Single contract for the tool inputs (CLAUDE.md §7); worker/mcp-server.ts registers the
// same schemas with the SDK.
export const ListCanvasesInput = z.object({ workspace_id: z.string().min(1) });
export const ListInboxInput = z.object({
  workspace_id: z.string().min(1),
  view: z.enum(['open', 'all', 'closed']).optional(),
});
export const ReadConversationInput = z.object({ chat_id: z.string().min(1) });
export const SendMessageInput = z.object({
  workspace_id: z.string().min(1),
  message: z.string().min(1),
  chat_id: z.string().min(1).optional(),
  canvas_id: z.string().min(1).optional(),
});
export const UploadSkillInput = z.object({
  workspace_id: z.string().min(1),
  name: SkillName,
  files: UploadSkillFiles.shape.files,
});

export interface McpToolDeps {
  db: Database;
  /** The OAuth access token's user — the human this connection acts as. */
  userId: string;
  /** Proxy a chat send into the workspace's bridge (wakes the container). Wired to
   * serveWorkspace + coordsForWorkspace in worker/mcp-server.ts; stubbed in tests. */
  proxySend: (workspaceId: string, chatId: string, message: string, canvasId?: string) => Promise<Response>;
  /** Proxy a skill upload to the bridge's PUT /api/skills/:name — the bridge is the single
   * writer of the workspace skills tree (the edge never writes skills.tar itself). */
  proxySkill: (workspaceId: string, name: string, input: UploadSkillFiles) => Promise<Response>;
}

const conversationView = (row: {
  id: string;
  ownerRef: string | null;
  status: string;
  waitingOn: string;
  kind: string;
  workspaceId: string;
  summary: string | null;
  lastMessagePreview: string | null;
  lastActivity: Date;
}) => ({
  chat_id: row.ownerRef,
  conversation_id: row.id,
  status: row.status,
  waiting_on: row.waitingOn,
  kind: row.kind,
  workspace_id: row.workspaceId,
  summary: row.summary,
  last_message_preview: row.lastMessagePreview,
  last_activity: row.lastActivity.getTime(),
});

export function buildMcpTools(deps: McpToolDeps) {
  const requireWorkspace = async (workspaceId: string) => {
    const ws = await getWorkspace(deps.db, workspaceId, deps.userId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    return ws;
  };

  return {
    async listWorkspaces() {
      const rows = await listWorkspaces(deps.db, deps.userId);
      return {
        workspaces: rows.map((w) => ({
          id: w.id,
          name: w.name,
          role: w.ownerUserId === deps.userId ? ('owner' as const) : ('member' as const),
        })),
      };
    },

    async listCanvases(input: z.infer<typeof ListCanvasesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const rows = await canvasRegistry.list(deps.db, ws.id);
      return { canvases: rows.map((c) => ({ id: c.id, name: c.name })) };
    },

    async listInbox(input: z.infer<typeof ListInboxInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const view = input.view ?? 'open';
      const rows = await conversations.list(deps.db, deps.userId, {
        workspaceId: ws.id,
        ...(view === 'open' ? { status: 'open' as const } : view === 'closed' ? { status: 'done' as const } : {}),
      });
      return { items: rows.map(conversationView) };
    },

    /** Poll handle for a send: 'starting' until row-at-start lands (the SDK init event
     * indexes the conversation seconds after a send), then the row's live metadata —
     * `waiting_on`/`last_message_preview` flip when the agent finishes its turn. */
    async readConversation(input: z.infer<typeof ReadConversationInput>) {
      const row = await conversations.getByOwnerRef(deps.db, input.chat_id);
      if (!row || row.userId !== deps.userId) return { chat_id: input.chat_id, status: 'starting' as const };
      return conversationView(row);
    },

    /** Async by design: returns the chat_id immediately (the bridge 202s and runs the turn
     * fire-and-forget); callers poll read_conversation. Always plain chat flavor — a
     * dev-agent conversation is not reachable through this tool. */
    async sendMessage(input: z.infer<typeof SendMessageInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      let chatId = input.chat_id;
      let canvasId = input.canvas_id;
      if (chatId) {
        const existing = await conversations.getByOwnerRef(deps.db, chatId);
        if (!existing || existing.userId !== deps.userId || existing.workspaceId !== ws.id || existing.kind !== 'chat') {
          throw new Error(`no chat conversation ${chatId} in workspace ${ws.id}`);
        }
        // A canvas-paired conversation stays addressed to its canvas (the row's canvasId —
        // what the pad stamps as x-canvas-id): otherwise the turn's canvas tools would bind
        // to the DEFAULT canvas store and the agent reads the wrong board. Explicit wins.
        canvasId ??= existing.canvasId ?? undefined;
      } else {
        chatId = `mcp_${crypto.randomUUID()}`;
      }
      const res = await deps.proxySend(ws.id, chatId, input.message, canvasId);
      if (!res.ok) throw new Error(`send failed (${res.status}): ${await res.text().catch(() => '')}`);
      return { chat_id: chatId, status: 'running' as const, poll: 'read_conversation' as const };
    },

    /** Skills are workspace CONTENT (ADR-0013): any member may add one — the same actor
     * could ask the chat agent to write the identical files. Available to the next turn. */
    async uploadSkill(input: z.infer<typeof UploadSkillInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const res = await deps.proxySkill(ws.id, input.name, { files: input.files });
      if (!res.ok) throw new Error(`skill upload failed (${res.status}): ${await res.text().catch(() => '')}`);
      return { skill: input.name, files: input.files.length, workspace_id: ws.id };
    },
  };
}

export type McpTools = ReturnType<typeof buildMcpTools>;
