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
// Same name constraint as the shell's create route (worker/shell.ts CreateCanvasInput).
export const CreateCanvasInput = z.object({ workspace_id: z.string().min(1), name: z.string().trim().min(1).max(100) });
export const RunDevAgentInput = z.object({ repo: z.string().min(1).optional(), job: z.string().min(1).optional() });
export const ListInboxInput = z.object({
  workspace_id: z.string().min(1),
  view: z.enum(['open', 'all', 'closed']).optional(),
  // Assignee filter (shared inbox): a member's user id, or 'unassigned' for the unclaimed queue.
  assigned: z.string().min(1).optional(),
});
export const ReadConversationInput = z.object({ chat_id: z.string().min(1) });
// Advisory assignment (shared inbox): a member's user id, or null to unassign.
export const AssignConversationInput = z.object({ chat_id: z.string().min(1), user_id: z.string().min(1).nullable() });
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
// MCP full access: direct reads (canvas, transcript) + the component library.
export const ReadTranscriptInput = z.object({ chat_id: z.string().min(1) });
export const ReadCanvasInput = z.object({
  workspace_id: z.string().min(1),
  canvas_id: z.string().min(1).optional(),
});
export const ListComponentsInput = ReadCanvasInput;
const ComponentModule = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'component name: letters/digits/_/-, no extension');
export const ReadComponentInput = ReadCanvasInput.extend({ module: ComponentModule });
// canvas_id is REQUIRED here (unlike the read paths' default-canvas fallback): a write
// silently landing in the default canvas's own dir when the caller meant a specific one
// is invisible until something tries to place/resolve the module there — an omitted
// canvas_id here, followed by place_component on a different canvas, 404s with no hint
// why. Forcing the caller to say which canvas surfaces the mistake immediately.
export const WriteComponentInput = ReadComponentInput.extend({ canvas_id: z.string().min(1), source: z.string().min(1) });
export const WriteDataInput = ReadCanvasInput.extend({
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]*\.(json|csv|txt|md)$/, 'data file name: letters/digits/_/- with a .json/.csv/.txt/.md extension'),
  source: z.string().min(1),
});
// Direct canvas mutation. Shapes ride as loose records on purpose: the bridge's
// normalizeShape is the single validator (same permissive-schema-strict-normalize split
// the in-canvas agent tools use), and its errors come back agent-legible.
const ShapeRecord = z.record(z.unknown());
export const CreateShapesInput = ReadCanvasInput.extend({ shapes: z.array(ShapeRecord).min(1) });
export const UpdateShapesInput = ReadCanvasInput.extend({
  shapes: z.array(ShapeRecord.and(z.object({ id: z.string().min(1) }))).min(1),
});
export const DeleteShapesInput = ReadCanvasInput.extend({ ids: z.array(z.string().min(1)).min(1) });
export const PlaceComponentInput = ReadCanvasInput.extend({
  id: z.string().min(1).optional(),
  module: ComponentModule,
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  data: z.record(z.unknown()).optional(),
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
  /** Generic bridge proxy (MCP full access): a request into the workspace's container
   * (wakes it if asleep). Wired to serveWorkspace + coordsForWorkspace in mcp-server.ts. */
  proxyBridge: (
    workspaceId: string,
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) => Promise<Response>;
  /** Kick a dev-agent run (the same manual trigger as the Jobs "Run now" route). Wired to
   * triggerDevAgentRun in worker/mcp-server.ts; stubbed in tests. */
  kickDevAgent: (body: { repo?: string; job?: string }) => Promise<Response>;
}

const conversationView = (row: {
  id: string;
  ownerRef: string | null;
  status: string;
  waitingOn: string;
  kind: string;
  workspaceId: string;
  assignedTo: string | null;
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
  assigned_to: row.assignedTo,
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

  /** The x-canvas-id header for a request into a workspace: absent = the default canvas;
   * a named canvas must be registered to THAT workspace (never a cross-workspace id). */
  const canvasHeader = async (workspaceId: string, canvasId?: string): Promise<Record<string, string>> => {
    if (!canvasId) return {};
    const rows = await canvasRegistry.list(deps.db, workspaceId);
    if (!rows.some((c) => c.id === canvasId)) throw new Error(`canvas not found in workspace: ${canvasId}`);
    return { 'x-canvas-id': canvasId };
  };

  /** Proxy + parse: a non-2xx bridge answer becomes a thrown error the MCP layer surfaces. */
  const bridgeJson = async (
    workspaceId: string,
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<unknown> => {
    const res = await deps.proxyBridge(workspaceId, path, init);
    if (!res.ok) throw new Error(`bridge ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text().catch(() => '')}`);
    return res.json();
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

    async createCanvas(input: z.infer<typeof CreateCanvasInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const row = await canvasRegistry.create(deps.db, { workspaceId: ws.id, name: input.name });
      return { id: row.id, name: row.name, workspace_id: ws.id };
    },

    /** Manual dev-agent trigger — an explicit user action, same as the Jobs "Run now"
     * button (never gated on DEV_AGENT_ENABLED; the bridge single-flights with JOIN). */
    async runDevAgent(input: z.infer<typeof RunDevAgentInput>) {
      const res = await deps.kickDevAgent(input);
      if (!res.ok) throw new Error(`dev-agent kick failed (${res.status}): ${await res.text().catch(() => '')}`);
      return res.json();
    },

    async listInbox(input: z.infer<typeof ListInboxInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const view = input.view ?? 'open';
      // Workspace-SHARED (CONTEXT.md): every member's sessions, never scoped to the token user.
      const rows = await conversations.list(deps.db, {
        workspaceId: ws.id,
        assigned: input.assigned,
        ...(view === 'open' ? { status: 'open' as const } : view === 'closed' ? { status: 'closed' as const } : {}),
      });
      return { items: rows.map(conversationView) };
    },

    /** Advisory assignment (shared inbox): any member assigns any member, or clears with
     * null — never a lock. The target must be a member of the conversation's workspace. */
    async assignConversation(input: z.infer<typeof AssignConversationInput>) {
      const row = await conversations.getByOwnerRef(deps.db, input.chat_id);
      if (!row || !(await getWorkspace(deps.db, row.workspaceId, deps.userId))) {
        throw new Error(`conversation not found: ${input.chat_id}`);
      }
      if (input.user_id !== null && !(await getWorkspace(deps.db, row.workspaceId, input.user_id))) {
        throw new Error(`assignee is not a workspace member: ${input.user_id}`);
      }
      const updated = await conversations.assign(deps.db, row.id, input.user_id);
      return conversationView(updated ?? row);
    },

    /** Poll handle for a send: 'starting' until row-at-start lands (the SDK init event
     * indexes the conversation seconds after a send), then the row's live metadata —
     * `waiting_on`/`last_message_preview` flip when the agent finishes its turn. */
    async readConversation(input: z.infer<typeof ReadConversationInput>) {
      const row = await conversations.getByOwnerRef(deps.db, input.chat_id);
      // Membership-gated (shared inbox): any member of the row's workspace reads it; an
      // inaccessible row reports the same 'starting' as a missing one (no existence leak).
      if (!row || !(await getWorkspace(deps.db, row.workspaceId, deps.userId))) {
        return { chat_id: input.chat_id, status: 'starting' as const };
      }
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
        // Membership suffices (shared inbox): requireWorkspace gated ws already; any member
        // may reply to any chat conversation in it — never creator-gated.
        const existing = await conversations.getByOwnerRef(deps.db, chatId);
        if (!existing || existing.workspaceId !== ws.id || existing.kind !== 'chat') {
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

    /** The full settled transcript of one of the user's conversations. Two bridge hops on
     * purpose: GET /api/inbox/:id/chat first (restores the session JSONL from R2 after a
     * cold boot and resolves the live chatId), then that chat's transcript. */
    async readTranscript(input: z.infer<typeof ReadTranscriptInput>) {
      const row = await conversations.getByOwnerRef(deps.db, input.chat_id);
      // Membership-gated (shared inbox), same line as readConversation.
      if (!row || !(await getWorkspace(deps.db, row.workspaceId, deps.userId))) {
        throw new Error(`conversation not found: ${input.chat_id}`);
      }
      const opened = (await bridgeJson(row.workspaceId, `/api/inbox/${encodeURIComponent(row.id)}/chat`)) as { chatId: string };
      const transcript = (await bridgeJson(row.workspaceId, `/api/chat/${encodeURIComponent(opened.chatId)}/transcript`)) as {
        events: unknown[];
      };
      return { chat_id: input.chat_id, workspace_id: row.workspaceId, events: transcript.events };
    },

    /** Read a canvas's full state (every shape) directly — no agent turn needed. */
    async readCanvas(input: z.infer<typeof ReadCanvasInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, '/api/canvas', { headers });
    },

    // The component library over the wire: the same list/read/write the in-canvas agent
    // has, proxied to the bridge (the single writer of the container filesystem).
    async listComponents(input: z.infer<typeof ListComponentsInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, '/api/components', { headers });
    },

    async readComponent(input: z.infer<typeof ReadComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `/api/components/${encodeURIComponent(input.module)}`, { headers });
    },

    async writeComponent(input: z.infer<typeof WriteComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `/api/components/${encodeURIComponent(input.module)}`, {
        method: 'PUT',
        headers,
        body: { source: input.source },
      });
    },

    async writeData(input: z.infer<typeof WriteDataInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `/api/components/data/${encodeURIComponent(input.name)}`, {
        method: 'PUT',
        headers,
        body: { source: input.source },
      });
    },

    // Direct canvas mutation: the same ops the in-canvas agent's tools call, proxied to
    // the bridge (no chat-card linking — an external client has no chat card).
    async createShapes(input: z.infer<typeof CreateShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, '/api/canvas/shapes/create', { method: 'POST', headers, body: { shapes: input.shapes } });
    },

    async updateShapes(input: z.infer<typeof UpdateShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, '/api/canvas/shapes/update', { method: 'POST', headers, body: { shapes: input.shapes } });
    },

    async deleteShapes(input: z.infer<typeof DeleteShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, '/api/canvas/delete', { method: 'POST', headers, body: { ids: input.ids } });
    },

    async placeComponent(input: z.infer<typeof PlaceComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const { workspace_id: _ws, canvas_id: _cv, ...placement } = input;
      return bridgeJson(ws.id, '/api/components/place', { method: 'POST', headers, body: placement });
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
