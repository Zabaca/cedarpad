import { z } from 'zod';
import {
  BRIDGE_ROUTES,
  CANVAS_ID_HEADER,
  CANVAS_VIEWER_HEADER,
  ComponentName,
  CreateShapesBody,
  DataFileName,
  DeleteShapesBody,
  PlaceComponentBody,
  UpdateShapesBody,
  WriteComponentBody,
  WriteDataBody,
} from '../shared/bridge-wire.ts';
import { resolvePageRef } from '../shared/canvas-pages.ts';
import { SkillName, UploadSkillInput as UploadSkillFiles } from '../shared/skills-wire.ts';
import type { CanvasPage } from '../src/shapes.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { listVisibleCanvases, listVisibleConversations, resolveCanvas, resolveConversationByOwnerRef } from './access.ts';
import { componentCatalog } from './component-catalog.ts';
import { d1RecordStore } from './record-store.ts';
import { DEFAULT_CANVAS_ID, DEFAULT_WORKSPACE_ID } from './shell-routing.ts';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { getWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';
import { buildNotebookTools } from '../web-poc/worker/notebook-tools.ts';

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
// `job` is required (#100): a run's task is always a repo-defined job's body — there is no
// built-in default prompt to fall back to.
export const RunDevAgentInput = z.object({ job: z.string().min(1), repo: z.string().min(1).optional() });
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
/** Reading a canvas may narrow to ONE page. Only `read_canvas` takes this — the other tools
 *  built on `ReadCanvasInput` address a library or a set of ids, neither of which is
 *  page-scoped. */
export const ReadCanvasPageInput = ReadCanvasInput.extend({
  page: z.string().min(1).optional(),
});
export const ListComponentsInput = ReadCanvasInput;
/** `page` takes a NAME as the human says it, or a `page:` id — `resolvePageRef` accepts
 *  both, so the caller never has to know which one it is holding. */
export const SelectPageInput = ReadCanvasInput.extend({ page: z.string().min(1) });
/** Addressing one module in one canvas — where read/write/edit all start. Not exported: it is
 *  shared structure, not a boundary anything parses against. */
const ComponentRef = ReadCanvasInput.extend({ module: ComponentName });
export const ReadComponentInput = ComponentRef.extend({
  // A line WINDOW, Claude Code's parameter names: 1-based `offset`, `limit` lines from it.
  // Both optional and both opt-in — omitting them keeps the whole-file shape this tool has
  // always returned, so `source` never quietly stops meaning "the file's actual text".
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
// canvas_id is REQUIRED here (unlike the read paths' default-canvas fallback): a write
// silently landing in the default canvas's own dir when the caller meant a specific one
// is invisible until something tries to place/resolve the module there — an omitted
// canvas_id here, followed by place_component on a different canvas, 404s with no hint
// why. Forcing the caller to say which canvas surfaces the mistake immediately.
// Built from ComponentRef, NOT from ReadComponentInput: a write has no line window, and
// inheriting one would advertise `offset`/`limit` on write_component that it then ignores.
export const WriteComponentInput = ComponentRef.extend({ canvas_id: z.string().min(1) }).merge(WriteComponentBody);
/**
 * A line-range edit: lines `start_line`..`end_line` (1-based, inclusive) become `content`.
 * Because the replacement may be any number of lines, inserting and deleting are the same
 * verb — there is no separate insert or delete tool to keep in step with this one.
 *
 * NOT the same shape as `server/agent.ts`'s in-container tool of the same name, which swaps a
 * unique `old_string` for a `new_string`. Different surface, different client — the in-canvas
 * agent holds the file's text in its own context and can quote it; an outside MCP client has
 * just read a numbered window and holds line numbers.
 *
 * `canvas_id` is required for the reason `write_component` requires it: this WRITES, and a
 * write that silently lands in the default canvas stays invisible until something later fails
 * to resolve it.
 */
export const EditComponentInput = ComponentRef.extend({
  canvas_id: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  content: z.string(),
});
export const WriteDataInput = ReadCanvasInput.extend({ name: DataFileName }).merge(WriteDataBody);
// Direct canvas mutation: the tool input is the canvas address plus the bridge's own body
// schema (shared/bridge-wire.ts), so the edge validates exactly what the bridge parses.
export const CreateShapesInput = ReadCanvasInput.merge(CreateShapesBody);
export const UpdateShapesInput = ReadCanvasInput.merge(UpdateShapesBody);
export const DeleteShapesInput = ReadCanvasInput.merge(DeleteShapesBody);
export const PlaceComponentInput = ReadCanvasInput.merge(PlaceComponentBody);

/**
 * Line addressing for a component's source (read_component's window, edit_component's range).
 *
 * A file ending in a newline splits to a trailing '' — an artifact, not a line: `wc -l` does
 * not count it and neither does anything a human calls "line 7". It is set aside here and put
 * back by `joinLines`, so a read reports the count a person would, and an edit round-trips a
 * file's final newline (or its absence) byte for byte.
 */
function splitLines(source: string): { lines: string[]; trailingNewline: boolean } {
  const parts = source.split('\n');
  const trailingNewline = parts.length > 1 && parts[parts.length - 1] === '';
  return { lines: trailingNewline ? parts.slice(0, -1) : parts, trailingNewline };
}

const joinLines = (lines: string[], trailingNewline: boolean) => lines.join('\n') + (trailingNewline ? '\n' : '');

/** `cat -n`: a right-aligned line number, a tab, the line. The numbers are NOT in the file —
 *  they exist so the range an agent passes to edit_component is one it actually read. */
const numberLines = (lines: string[], offset: number) =>
  lines.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n');

export interface McpToolDeps {
  db: Database;
  /** The OAuth access token's user — the human this connection acts as. */
  userId: string;
  /** Ring a workspace's events hub (#383). MCP is a third writer of the conversations
   *  table, next to the edge routes and the container's platform RPC, so a claim made from
   *  an agent has to reach every open Shell's badge like one made from the Inbox does. A
   *  dep rather than a binding read, matching every other outward call here. */
  notify: (workspaceId: string) => Promise<void>;
  /** Proxy a chat send into the workspace's bridge (wakes the container). Wired to
   * serveWorkspace + coordsForWorkspace in worker/mcp-server.ts; stubbed in tests. */
  proxySend: (workspaceId: string, chatId: string, message: string, canvasId?: string) => Promise<Response>;
  /** Proxy a skill upload to the bridge's PUT /api/skills/:name — the bridge is the single
   * writer of the workspace skills tree (the edge never renders skill files itself). */
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
  kickDevAgent: (body: { job: string; repo?: string }) => Promise<Response>;
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
   * a named canvas must be registered to THAT workspace (never a cross-workspace id).
   * ADR-0016: a private canvas that isn't the token user's is the same error as a
   * missing one — this is the choke point every canvas tool funnels through. */
  const canvasHeader = async (workspaceId: string, canvasId?: string): Promise<Record<string, string>> => {
    if (!canvasId) return {};
    if (!(await resolveCanvas(deps.db, workspaceId, canvasId, deps.userId))) {
      throw new Error(`canvas not found in workspace: ${canvasId}`);
    }
    return { [CANVAS_ID_HEADER]: canvasId };
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
    /**
     * The Notebook's tools (ADR-0024), bound to this connection's workspace. They are built
     * per call rather than once, because the binding — not an argument — is what makes them
     * safe: no notebook tool takes a workspace, so there is nowhere for a caller to name one.
     *
     * WHICH workspace: the token user's **home** workspace, the oldest one they own or
     * belong to (`listWorkspaces` is `createdAt`-ascending), falling back to the legacy
     * `default` for a user who has none. An OAuth token identifies a person, not a
     * workspace, so this is a rule rather than something the credential carries — and it is
     * deliberately the same answer on every call, so an agent's observations do not scatter
     * across workspaces between one tool call and the next.
     */
    async notebook() {
      const rows = await listWorkspaces(deps.db, deps.userId);
      return buildNotebookTools({
        db: deps.db,
        workspaceId: rows[0]?.id ?? DEFAULT_WORKSPACE_ID,
        userId: deps.userId,
        origin: 'agent',
      });
    },

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
      // ADR-0016: the token user sees workspace-visible canvases plus their own private ones.
      const rows = await listVisibleCanvases(deps.db, ws.id, deps.userId);
      return { canvases: rows.map((c) => ({ id: c.id, name: c.name, visibility: c.visibility })) };
    },

    async createCanvas(input: z.infer<typeof CreateCanvasInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const row = await canvasRegistry.create(deps.db, { workspaceId: ws.id, name: input.name, createdBy: deps.userId });
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
      // ADR-0016 visibility (own flag, or a private canvas) is applied inside the seam.
      const visible = await listVisibleConversations(deps.db, ws.id, deps.userId, {
        assigned: input.assigned,
        ...(view === 'open' ? { status: 'open' as const } : view === 'closed' ? { status: 'closed' as const } : {}),
      });
      return { items: visible.map(conversationView) };
    },

    /** Advisory assignment (shared inbox): any member assigns any member, or clears with
     * null — never a lock. The target must be a member of the conversation's workspace. */
    async assignConversation(input: z.infer<typeof AssignConversationInput>) {
      const row = await resolveConversationByOwnerRef(deps.db, input.chat_id, deps.userId);
      if (!row) {
        throw new Error(`conversation not found: ${input.chat_id}`);
      }
      if (input.user_id !== null && !(await getWorkspace(deps.db, row.workspaceId, input.user_id))) {
        throw new Error(`assignee is not a workspace member: ${input.user_id}`);
      }
      const updated = await conversations.assign(deps.db, row.id, input.user_id);
      await deps.notify(row.workspaceId);
      return conversationView(updated ?? row);
    },

    /** Poll handle for a send: 'starting' until row-at-start lands (the SDK init event
     * indexes the conversation seconds after a send), then the row's live metadata —
     * `waiting_on`/`last_message_preview` flip when the agent finishes its turn. */
    async readConversation(input: z.infer<typeof ReadConversationInput>) {
      // Membership-gated (shared inbox): any member of the row's workspace reads it; an
      // inaccessible row reports the same 'starting' as a missing one (no existence leak).
      const row = await resolveConversationByOwnerRef(deps.db, input.chat_id, deps.userId);
      if (!row) {
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
        // The workspace-match and kind legs stay here: they are this tool's own contract
        // (a chat in THIS workspace), not access — the seam covers membership + visibility.
        const existing = await resolveConversationByOwnerRef(deps.db, chatId, deps.userId);
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
      // Membership-gated (shared inbox), same line as readConversation.
      const row = await resolveConversationByOwnerRef(deps.db, input.chat_id, deps.userId);
      if (!row) {
        throw new Error(`conversation not found: ${input.chat_id}`);
      }
      const opened = (await bridgeJson(row.workspaceId, `/api/inbox/${encodeURIComponent(row.id)}/chat`)) as { chatId: string };
      const transcript = (await bridgeJson(row.workspaceId, `/api/chat/${encodeURIComponent(opened.chatId)}/transcript`)) as {
        events: unknown[];
      };
      return { chat_id: input.chat_id, workspace_id: row.workspaceId, events: transcript.events };
    },

    /** Read a canvas's full state (every shape) directly — no agent turn needed. */
    async readCanvas(input: z.infer<typeof ReadCanvasPageInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      // The filter runs at the BRIDGE, not here: narrowing after the fact would still drag
      // the whole canvas across this hop, and the hop is what the response limit measures.
      const path = input.page ? `${BRIDGE_ROUTES.canvas}?page=${encodeURIComponent(input.page)}` : BRIDGE_ROUTES.canvas;
      return bridgeJson(ws.id, path, { headers });
    },

    /**
     * Ask the TOKEN USER's own open tabs on this canvas to switch to a page. Presentation
     * only: the document does not change, and nobody else's screen moves — a canvas is a
     * shared surface, and yanking a colleague's view because someone else's agent asked is
     * an act they never consented to.
     *
     * `asked` counts the views the request REACHED, not the views that changed: the leg is
     * fire-and-forget and a browser still declines a page it has not synced yet. 0 is the
     * certain fact — that user has no tab open here (or is on a different canvas) — and it
     * is reported rather than swallowed.
     */
    async selectPage(input: z.infer<typeof SelectPageInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const state = (await bridgeJson(ws.id, BRIDGE_ROUTES.canvas, { headers })) as { pages?: CanvasPage[] };
      // Resolve HERE, at the edge: the bridge takes an id only, so a name never reaches a
      // layer whose job is structure rather than naming.
      const pageId = resolvePageRef(state.pages ?? [], input.page);
      const res = (await bridgeJson(ws.id, BRIDGE_ROUTES.selectPage, {
        method: 'POST',
        // The viewer is the OAuth token's user — this proxy is a synthetic request the edge
        // builds, so worker/index.ts's browser-path stamping never ran for it.
        headers: { ...headers, [CANVAS_VIEWER_HEADER]: deps.userId },
        body: { pageId },
      })) as { asked: number };
      return { page_id: pageId, asked: res.asked };
    },

    // The component library over the wire: the same list/read/write the in-canvas agent
    // has, proxied to the bridge (the single writer of the container filesystem) — except
    // the LISTING, which is answered here at the edge (ADR-0022, #363). Own and shared are
    // Records the edge owns and the platform tier is a manifest bundled with this worker, so
    // an outside agent browsing the library never wakes (or bills) a container.
    async listComponents(input: z.infer<typeof ListComponentsInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      // The same access choke point every canvas tool funnels through — it just yields the
      // canvas id rather than a header now, because there is no request to stamp it onto.
      await canvasHeader(ws.id, input.canvas_id);
      const details = await componentCatalog(d1RecordStore(deps.db), {
        workspaceId: ws.id,
        canvasId: input.canvas_id ?? DEFAULT_CANVAS_ID,
      });
      return { components: details.map((d) => d.name), details };
    },

    async readComponent(input: z.infer<typeof ReadComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const res = (await bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/${encodeURIComponent(input.module)}`, { headers })) as {
        module: string;
        source: string;
      };
      if (input.offset === undefined && input.limit === undefined) return res;
      // The window is applied HERE rather than at the bridge: the source has already crossed
      // the hop by the time anyone could slice it, so a bridge-side window would save nothing
      // — what it costs is a second contract to keep in step with this one.
      const { lines } = splitLines(res.source);
      const offset = input.offset ?? 1;
      // Overrunning the END is ordinary paging and clamps. STARTING past the end does not:
      // an empty window is indistinguishable from an empty file, and an agent that believes
      // the file is empty writes over it. Report the length instead.
      if (offset > lines.length) {
        throw new Error(`read_component ${res.module}: offset ${offset} is past the end of the file (${lines.length} lines)`);
      }
      const shown = lines.slice(offset - 1, input.limit === undefined ? undefined : offset - 1 + input.limit);
      // `limit` reports how many lines actually came back — what was asked for, unless the
      // window ran off the end, which is how a caller tells paging from the last page.
      return { module: res.module, offset, limit: shown.length, lines: lines.length, source: numberLines(shown, offset) };
    },

    async writeComponent(input: z.infer<typeof WriteComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/${encodeURIComponent(input.module)}`, {
        method: 'PUT',
        headers,
        body: { source: input.source },
      });
    },

    /**
     * Read-modify-write at the EDGE, over the same two bridge routes read/write already use.
     * The bridge stays the single writer of the container filesystem and needs no new route;
     * its PUT persists the Record and bumps the hot-reload rev, so a placed instance reloads
     * from an edit exactly as it does from a write.
     *
     * The lost-update window between the GET and the PUT is the one `write_component` already
     * has — whoever PUTs last wins — and `component_history` in the container can undo it.
     */
    async editComponent(input: z.infer<typeof EditComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const path = `${BRIDGE_ROUTES.components}/${encodeURIComponent(input.module)}`;
      const current = (await bridgeJson(ws.id, path, { headers })) as { source: string };
      const { lines, trailingNewline } = splitLines(current.source);
      // Refuse an impossible range BEFORE the PUT. An out-of-date range is the expected
      // mistake — every edit shifts the numbers below it — and clamping it would quietly
      // rewrite lines the caller never named. The count tells them what to re-read against.
      if (input.end_line < input.start_line) {
        throw new Error(`edit_component ${input.module}: end_line ${input.end_line} is before start_line ${input.start_line}`);
      }
      for (const [field, value] of [
        ['start_line', input.start_line],
        ['end_line', input.end_line],
      ] as const) {
        if (value > lines.length) {
          throw new Error(`edit_component ${input.module}: ${field} ${value} is past the end of the file (${lines.length} lines)`);
        }
      }
      // Empty content DELETES the range: "replace these lines with nothing" is the reading an
      // agent means, and a range replacement of a different length is how it also inserts.
      const replacement = input.content === '' ? [] : splitLines(input.content).lines;
      const next = [...lines.slice(0, input.start_line - 1), ...replacement, ...lines.slice(input.end_line)];
      const res = (await bridgeJson(ws.id, path, {
        method: 'PUT',
        headers,
        body: { source: joinLines(next, trailingNewline) },
      })) as Record<string, unknown>;
      // `lines` is the NEW total: an edit that changes the line count shifts every number
      // below it, and the caller has to know to re-read before addressing another range.
      return { ...res, lines: next.length, replaced: { start_line: input.start_line, end_line: input.end_line } };
    },

    async writeData(input: z.infer<typeof WriteDataInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/data/${encodeURIComponent(input.name)}`, {
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
      return bridgeJson(ws.id, BRIDGE_ROUTES.shapesCreate, { method: 'POST', headers, body: { shapes: input.shapes } });
    },

    async updateShapes(input: z.infer<typeof UpdateShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, BRIDGE_ROUTES.shapesUpdate, { method: 'POST', headers, body: { shapes: input.shapes } });
    },

    async deleteShapes(input: z.infer<typeof DeleteShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, BRIDGE_ROUTES.deleteShapes, { method: 'POST', headers, body: { ids: input.ids } });
    },

    async placeComponent(input: z.infer<typeof PlaceComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const { workspace_id: _ws, canvas_id: _cv, ...placement } = input;
      return bridgeJson(ws.id, BRIDGE_ROUTES.componentsPlace, { method: 'POST', headers, body: placement });
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
