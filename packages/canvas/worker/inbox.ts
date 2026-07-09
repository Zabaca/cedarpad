import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { orderInbox, viewToListOpts } from './inbox-view.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';

// The edge Inbox API (ADR-0007, PRD #50 slice #62). The user-scoped attention inbox,
// served AT THE EDGE against remote Turso — so listing Conversations and reading their
// metadata never wakes a container (the runner can sleep). The transcript is NO LONGER read
// here: under ADR-0009 / #124 the Inbox thread is a live <ChatView> over the owning bridge
// (via the /inbox/:id/bridge proxy), so history streams from the runner, not an R2 photograph.
// Only a reply / opening the thread wakes the runner. The PURE list-ordering lives here too,
// unit-tested without the edge runtime.

const db = (env: Env) => createDbForWorker(env as unknown as Bindings);

/**
 * The edge Inbox API, user-scoped from the authenticated session:
 *   GET  /api/inbox                 → { items: InboxItem[] }  (filters: status, workspace)
 *   GET  /api/inbox/:id             → { conversation }  (Turso metadata only — never wakes a runner)
 *   POST /api/inbox/:id/reply       → forwarded to the container bridge (wakes it, #61)
 *   POST /api/inbox/:id/close       → store close
 *   POST /api/inbox/:id/reopen      → store reopen
 * Every per-id route verifies the Conversation belongs to the caller (else 404).
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
    // Unified session index: `?view=needs-me|all|closed` (default needs-me = the attention subset).
    const listOpts = viewToListOpts(url.searchParams.get('view'));
    const workspaceId = url.searchParams.get('workspace') ?? undefined;
    const rows = await conversations.list(database, user.id, { ...listOpts, workspaceId });
    return Response.json({ items: orderInbox(rows) });
  }

  const conv = await conversations.get(database, id);
  if (!conv || conv.userId !== user.id) return Response.json({ error: 'conversation not found' }, { status: 404 });

  // Reply forwards into the container (wakes it) — the bridge restores + resumes the Session.
  if (action === 'reply') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    return serveWorkspace(request, env, coordsForWorkspace(conv.workspaceId));
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
