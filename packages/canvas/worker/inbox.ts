import { z } from 'zod';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { getWorkspace, setInboxReadAt } from '../web-poc/lib/db/queries/workspaces.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { orderInbox, unseenCount, viewToListOpts, type InboxItem } from './inbox-view.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import { activeWorkspaceId } from './shell.ts';
import { listVisibleConversations, resolveConversationById } from './access.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';

// The edge Inbox API (ADR-0007, PRD #50 slice #62). The WORKSPACE-SHARED session index,
// served AT THE EDGE against remote Turso — so listing Conversations and reading their
// metadata never wakes a container (the runner can sleep). The transcript is NO LONGER read
// here: under ADR-0009 / #124 the Inbox thread is a live <ChatView> over the owning bridge
// (via the /inbox/:id/bridge proxy), so history streams from the runner, not an R2 photograph.
// Only a reply / opening the thread wakes the runner. The PURE list-ordering lives here too,
// unit-tested without the edge runtime.

const db = (env: Env) => createDbForWorker(env as unknown as Bindings);

/** POST /api/inbox/:id/assign body (CLAUDE.md §7 — parse at the boundary): a workspace
 *  member's user id, or null to unassign. */
const AssignInput = z.object({ userId: z.string().min(1).nullable() });

/** POST /api/inbox/:id/visibility body (ADR-0016): the chat's own flag, creator-only. */
const VisibilityInput = z.object({ visibility: z.enum(['shared', 'private']) });

/** How often /api/inbox/events re-reads Turso per connected client. */
export const INBOX_EVENTS_INTERVAL_MS = 10_000;

/** The caller's view of the inbox: rows scoped to the workspace, ADR-0016 visibility
 *  applied (a private chat that isn't theirs, or any chat on someone else's private
 *  canvas — canvas dominates; derived via one registry read, never copied), ordered. */
async function visibleInbox(
  database: ReturnType<typeof db>,
  workspaceId: string,
  userId: string,
  listOpts: ReturnType<typeof viewToListOpts>,
  assigned?: string,
): Promise<InboxItem[]> {
  return orderInbox(await listVisibleConversations(database, workspaceId, userId, { ...listOpts, assigned }));
}

/** The workspace's shared read mark as epoch ms (0 = never read). */
async function inboxReadAt(database: ReturnType<typeof db>, workspaceId: string, userId: string): Promise<number> {
  const ws = await getWorkspace(database, workspaceId, userId);
  return ws?.inboxReadAt ? ws.inboxReadAt.getTime() : 0;
}

/**
 * The edge Inbox API — WORKSPACE-SHARED (CONTEXT.md): visibility and action are
 * membership-gated, never creator-gated.
 *   GET  /api/inbox                 → { items: InboxItem[], me, readAt }  (filters: ?view=, ?assigned=<userId|unassigned>; scoped to the active workspace)
 *   GET  /api/inbox/events          → SSE { count, readAt } (the nav badge, pushed live)
 *   POST /api/inbox/read            → stamp the SHARED read mark (read-for-all)
 *   GET  /api/inbox/:id             → { conversation }  (Turso metadata only — never wakes a runner)
 *   POST /api/inbox/:id/reply       → forwarded to the container bridge (wakes it, #61)
 *   POST /api/inbox/:id/close       → store close
 *   POST /api/inbox/:id/reopen      → store reopen
 *   POST /api/inbox/:id/assign     → advisory assignment: { userId } (a member) or { userId: null }
 * Every per-id route verifies the caller is a member of the Conversation's workspace (else 404).
 */
export async function handleInboxApi(
  request: Request,
  env: Env,
  user: GateUser,
  id?: string,
  action?: string,
): Promise<Response> {
  const database = db(env);
  const url = new URL(request.url);

  // List.
  if (!id) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    // Scoped to the ACTIVE workspace (the cs_workspace cookie, exactly how /api/canvases scopes) —
    // an unknown/non-owned cookie 404s, same as handleCanvasesApi's mutation routes.
    const workspaceId = await activeWorkspaceId(request, database, user);
    if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });
    // Unified session index: `?view=open|all|closed` (default open) + `?assigned=` composing
    // with any view (absent = Everyone / a member's id / 'unassigned' = the unclaimed queue).
    const listOpts = viewToListOpts(url.searchParams.get('view'));
    const assigned = url.searchParams.get('assigned') ?? undefined;
    const items = await visibleInbox(database, workspaceId, user.id, listOpts, assigned);
    // The SHARED read mark (read-for-all): the client badges items newer than this.
    const readAt = await inboxReadAt(database, workspaceId, user.id);
    return Response.json({ items, me: user.id, readAt });
  }

  // GET /api/inbox/events — SSE: pushes the caller's nav-badge count ({count, readAt})
  // whenever it changes, so every open Shell updates live (no client polling). The edge
  // watches Turso (writes come from both the edge and container bridges — no pub/sub bus
  // yet), so latency is one INBOX_EVENTS_INTERVAL_MS tick. Per-user: visibility-filtered.
  if (id === 'events' && !action) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    const workspaceId = await activeWorkspaceId(request, database, user);
    if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let last = -1;
        const tick = async () => {
          try {
            const items = await visibleInbox(database, workspaceId, user.id, viewToListOpts(null));
            const readAt = await inboxReadAt(database, workspaceId, user.id);
            const count = unseenCount(items, readAt);
            if (count !== last) {
              last = count;
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ count, readAt })}\n\n`));
            } else {
              controller.enqueue(enc.encode(': keep-alive\n\n')); // detects a gone client
            }
          } catch {
            // Client disconnected (enqueue threw) or a read failed: stop the loop.
            if (timer) clearInterval(timer);
            timer = null;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };
        void tick();
        timer = setInterval(() => void tick(), INBOX_EVENTS_INTERVAL_MS);
      },
      cancel: () => {
        if (timer) clearInterval(timer);
        timer = null;
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  // POST /api/inbox/read — stamp the shared read mark for the active workspace (any
  // member; single-inbox semantics: one mark, everyone's badge clears). `read` sits in
  // the :id path slot but can never collide with a conversation id (`chat_<uuid>`).
  if (id === 'read' && !action) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const workspaceId = await activeWorkspaceId(request, database, user);
    if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });
    const at = new Date();
    await setInboxReadAt(database, workspaceId, at);
    return Response.json({ readAt: at.getTime() });
  }

  // Membership gate (shared inbox): any member of the Conversation's workspace may see and
  // act on it; a stranger gets the same 404 as a missing row (no existence leak). ADR-0016:
  // hidden rows 404 like missing ones too, on every per-id action. Composed in access.ts.
  const conv = await resolveConversationById(database, id, user.id);
  if (!conv) {
    return Response.json({ error: 'conversation not found' }, { status: 404 });
  }

  // ADR-0016: the chat's own privacy flag — its creator only (the edge-attested initiator;
  // legacy rows without one have no toggle). Not an owner power (manage-not-read is canvas-level).
  if (action === 'visibility') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (!conv.createdBy || conv.createdBy !== user.id) {
      return Response.json({ error: 'only the chat creator can change visibility' }, { status: 403 });
    }
    const parsed = VisibilityInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid visibility body' }, { status: 400 });
    const updated = await conversations.setVisibility(database, id, parsed.data.visibility);
    return Response.json({ conversation: updated });
  }

  // Reply forwards into the container (wakes it) — the bridge restores + resumes the Session.
  if (action === 'reply') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    return serveWorkspace(request, env, coordsForWorkspace(conv.workspaceId));
  }

  // Advisory assignment (never a lock): any member assigns any member, or clears. The
  // target must itself be a member of the Conversation's workspace — 400 otherwise.
  if (action === 'assign') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const parsed = AssignInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid assign body' }, { status: 400 });
    const target = parsed.data.userId;
    if (target !== null && !(await getWorkspace(database, conv.workspaceId, target))) {
      return Response.json({ error: 'assignee is not a workspace member' }, { status: 400 });
    }
    const updated = await conversations.assign(database, id, target);
    return Response.json({ conversation: updated });
  }

  if (action === 'close' || action === 'reopen') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const updated =
      action === 'close' ? await conversations.close(database, id) : await conversations.reopen(database, id);
    return Response.json({ conversation: updated });
  }

  // Detail: the Conversation METADATA only (Turso, no wake). The transcript is served by the
  // owning bridge via the /inbox/:id/bridge proxy now (ADR-0009 / #124), not read from R2 here.
  if (request.method === 'GET') {
    return Response.json({ conversation: conv });
  }
  return new Response('method not allowed', { status: 405 });
}
