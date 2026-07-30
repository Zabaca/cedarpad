import { z } from 'zod';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { getWorkspace, setInboxReadAt } from '../web-poc/lib/db/queries/workspaces.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { inboxBadgeSource, inboxBadgeStream } from './inbox-badge.ts';
import { notifyInboxChanged, subscribeToWorkspace } from './workspace-events.ts';
import { orderInbox, viewToListOpts, type InboxItem } from './inbox-view.ts';
import { mintDevAgentGitToken } from './github-app.ts';
import { resolveDevAgentRepo } from './github-connection.ts';
import { mergePullRequest } from './pr-merge.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import { activeWorkspaceId } from './shell.ts';
import { listVisibleConversations, resolveConversationById } from './access.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';

// The edge Inbox API (ADR-0007, PRD #50 slice #62). The WORKSPACE-SHARED session index,
// served AT THE EDGE against the platform D1 — so listing Conversations and reading their
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

/**
 * How often an idle /api/inbox/events stream writes a comment frame. It reads NOTHING —
 * its whole job is to notice a client that went away, which the old 10s recompute used to
 * do as a side effect. Keep it comfortably under the ~60s idle timeout intermediaries
 * apply to a quiet response body.
 */
export const INBOX_EVENTS_KEEPALIVE_MS = 30_000;

/**
 * How often a stream checks the watermark anyway, in case a notification never arrived.
 * Ringing the hub is best-effort by construction (`notifyInboxChanged`) — the write has
 * already committed by then — so without this a lost notice would leave a badge stale
 * until the next change. One indexed row every five minutes is what that insurance costs:
 * 12 rows per connected tab per hour, against the 5,760 the 10s recompute used to read.
 */
export const INBOX_EVENTS_SAFETY_NET_MS = 300_000;

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

/** The merge route's outward-facing collaborators, as default-parameter test seams (the
 *  shape `inbox-bridge.ts` uses): production always resolves the repo, mints, and calls
 *  GitHub for real. */
export interface InboxApiDeps {
  resolveRepo: typeof resolveDevAgentRepo;
  mint: typeof mintDevAgentGitToken;
  merge: typeof mergePullRequest;
}

/**
 * The edge Inbox API — WORKSPACE-SHARED (CONTEXT.md): visibility and action are
 * membership-gated, never creator-gated.
 *   GET  /api/inbox                 → { items: InboxItem[], me, readAt }  (filters: ?view=, ?assigned=<userId|unassigned>; scoped to the active workspace)
 *   GET  /api/inbox/events          → SSE { count, readAt } (the nav badge, pushed live)
 *   POST /api/inbox/read            → stamp the SHARED read mark (read-for-all)
 *   GET  /api/inbox/:id             → { conversation }  (D1 metadata only — never wakes a runner)
 *   POST /api/inbox/:id/reply       → forwarded to the container bridge (wakes it, #61)
 *   POST /api/inbox/:id/close       → store close
 *   POST /api/inbox/:id/reopen      → store reopen
 *   POST /api/inbox/:id/assign     → advisory assignment: { userId } (a member) or { userId: null }
 *   POST /api/inbox/:id/merge      → squash-merge the run's open PR, stamp + close the row
 * Every per-id route verifies the caller is a member of the Conversation's workspace (else 404).
 */
export async function handleInboxApi(
  request: Request,
  env: Env,
  user: GateUser,
  id?: string,
  action?: string,
  deps: InboxApiDeps = { resolveRepo: resolveDevAgentRepo, mint: mintDevAgentGitToken, merge: mergePullRequest },
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
  // whenever it changes, so every open Shell updates live. Per-user: visibility-filtered.
  //
  // PUSHED, NOT POLLED (#383). The stream attaches to its workspace's events hub — one
  // Durable Object per workspace, because Workers are stateless per isolate and a write
  // landing on isolate B cannot otherwise reach a subscriber held on isolate A — and every
  // conversation writer rings that hub after committing. The hub carries no count; it says
  // "your inbox changed" and this stream re-reads. Badge latency is therefore one hub hop
  // plus one D1 read, not the 10s tick it used to be.
  //
  // Two timers remain, and neither is the old recompute:
  //   - keep-alive, which reads nothing and exists to notice a departed client;
  //   - a five-minute watermark check, because ringing the hub is best-effort and a lost
  //     notice must not strand the badge.
  // Transport stays SSE: it is one-way server→client, the client already speaks it, and
  // WebSocket would be more machinery for a number. The SSE body is held by the WORKER,
  // not by the hub — DO hibernation is WebSocket-only, so a hub holding these streams
  // would stay resident for as long as any tab anywhere had the app open.
  if (id === 'events' && !action) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    const workspaceId = await activeWorkspaceId(request, database, user);
    if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });
    const source = inboxBadgeSource(database, workspaceId, user.id);
    // Attached before the response is returned, so no notice can slip between the first
    // read and the subscription. Null when there is no hub (unit tests, a binding-less
    // env): the stream then runs on its safety net alone, which is the old behaviour minus
    // the cost, not a broken badge.
    const hub = await subscribeToWorkspace(env.WORKSPACE_EVENTS, workspaceId);
    return new Response(
      inboxBadgeStream(source, hub, {
        keepAliveMs: INBOX_EVENTS_KEEPALIVE_MS,
        safetyNetMs: INBOX_EVENTS_SAFETY_NET_MS,
      }),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
    );
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
    await notifyInboxChanged(env.WORKSPACE_EVENTS, workspaceId);
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
    await notifyInboxChanged(env.WORKSPACE_EVENTS, conv.workspaceId);
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
    await notifyInboxChanged(env.WORKSPACE_EVENTS, conv.workspaceId);
    return Response.json({ conversation: updated });
  }

  // Land the run's PR (CONTEXT.md "Open PR"). Membership-gated like every other per-id action
  // (the resolve above already 404'd a stranger) — merging is inbox triage, not repo config;
  // the owner's gate was installing the App and selecting the repo. The merge happens HERE
  // rather than in the container because the App private key never leaves the edge (ADR-0008).
  if (action === 'merge') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (!conv.prUrl) return Response.json({ error: 'this conversation has no open PR' }, { status: 409 });
    if (conv.prMergedAt) return Response.json({ error: 'this PR has already been merged' }, { status: 409 });

    // The conversation's OWN repo (ADR-0015: one run = one repo); legacy rows without the
    // edge fall back to the workspace's first selected repo, exactly as a send does.
    const resolved = await deps.resolveRepo(env, database, conv.workspaceId, conv.repo ?? undefined);
    const token = resolved
      ? await deps.mint(env, { nowSec: Math.floor(Date.now() / 1000), ...resolved })
      : null;
    // No credential ⇒ stop. Never attempt the merge token-less: the failure would come back
    // as GitHub's opaque 404 rather than "this workspace has no write access to that repo".
    if (!token) {
      return Response.json({ error: 'no GitHub credential for this repo — check the workspace’s repository connection' }, { status: 502 });
    }

    const result = await deps.merge({ prUrl: conv.prUrl, token });
    // GitHub reporting the PR as already merged means the ROW was stale, not that the merge
    // failed — record it as merged rather than showing the human an error about it.
    if (!result.ok && !result.alreadyMerged) return Response.json({ error: result.reason }, { status: 409 });
    const updated = await conversations.markPrMerged(database, id);
    await notifyInboxChanged(env.WORKSPACE_EVENTS, conv.workspaceId);
    return Response.json({ conversation: updated });
  }

  if (action === 'close' || action === 'reopen') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const updated =
      action === 'close' ? await conversations.close(database, id) : await conversations.reopen(database, id);
    await notifyInboxChanged(env.WORKSPACE_EVENTS, conv.workspaceId);
    return Response.json({ conversation: updated });
  }

  // Detail: the Conversation METADATA only (D1, no wake). The transcript is served by the
  // owning bridge via the /inbox/:id/bridge proxy now (ADR-0009 / #124), not read from R2 here.
  if (request.method === 'GET') {
    return Response.json({ conversation: conv });
  }
  return new Response('method not allowed', { status: 405 });
}
