import { z } from 'zod';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { orderInbox, viewToListOpts } from './inbox-view.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import { activeWorkspaceId } from './shell.ts';
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

/**
 * The edge Inbox API — WORKSPACE-SHARED (CONTEXT.md): visibility and action are
 * membership-gated, never creator-gated.
 *   GET  /api/inbox                 → { items: InboxItem[] }  (filters: ?view=, ?assigned=<userId|unassigned>; scoped to the active workspace)
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
    const rows = await conversations.list(database, { ...listOpts, workspaceId, assigned });
    return Response.json({ items: orderInbox(rows) });
  }

  const conv = await conversations.get(database, id);
  // Membership gate (shared inbox): any member of the Conversation's workspace may see and
  // act on it; a stranger gets the same 404 as a missing row (no existence leak).
  if (!conv || !(await getWorkspace(database, conv.workspaceId, user.id))) {
    return Response.json({ error: 'conversation not found' }, { status: 404 });
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
