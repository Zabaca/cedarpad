import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import type { GateUser } from './auth-gate.ts';
import { DEV_AGENT_SANDBOX_ID } from './dev-agent.ts';
import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE, type SandboxCoords, resolve } from './sandbox-resolver.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import { DEFAULT_WORKSPACE_ID } from './shell-routing.ts';

// The edge chat proxy (ADR-0009, PRD #119 slice #122). Under "one chat system" every chat
// surface is a LIVE VIEW of its session's runner bridge; a Shell-mounted <ChatView> points
// its `chat-store` connection-target prefix at `/inbox/:convId/bridge` so its stream + send +
// interrupt + transcript + `/api/alive` all address the Conversation's OWNING bridge instead
// of same-origin. This module owns that resolution (`conv.workspaceId → coords`) and the
// proxy, kept SEPARATE from the edge Inbox list/detail API (`inbox.ts`) so the Worker's test
// can exercise the real proxy while still stubbing that Turso/R2-backed list handler.

const db = (env: Env) => createDbForWorker(env as unknown as Bindings);

/**
 * Resolve a Conversation's workspace to its owning runner's coordinates:
 *   - the legacy `default` id → the legacy/prod container;
 *   - a dev-agent Conversation (`workspaceId === DEV_AGENT_WORKSPACE_ID`, which is
 *     `'dev-agent'` — disjoint-by-construction from every product workspace id, and equal to
 *     `DEV_AGENT_SANDBOX_ID`) → the dev-agent's OWN sandbox, where its interactive bridge
 *     runs (ADR-0009 Tier 2). It must NOT take the derived `workspace-<id>` scheme, which
 *     would point at a `workspace-dev-agent` container that holds no bridge session;
 *   - any other id → its derived per-workspace container.
 */
export const coordsForWorkspace = (workspaceId: string): SandboxCoords =>
  workspaceId === DEV_AGENT_SANDBOX_ID
    ? { sandboxId: DEV_AGENT_SANDBOX_ID, r2Prefix: `workspaces/${DEV_AGENT_SANDBOX_ID}/`, canvasWorkspace: DEV_AGENT_SANDBOX_ID }
    : resolve(workspaceId === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE : { id: workspaceId });

/**
 * The edge chat proxy: `/inbox/:convId/bridge/*`. Resolve the Conversation (ownership-checked
 * against the gated `user`, 404 otherwise), map `conv.workspaceId → coords`, strip the
 * `/inbox/:convId/bridge` routing prefix, and proxy the remaining `subPath` (the raw bridge
 * path — `/api/...`, captured query-free by the route; the query rides on `request.url`) to
 * that runner's container via `serveWorkspace` — the SAME unbuffered proxy the pad uses, so
 * SSE streams through. `subPath` reaches the bridge unrewritten (the container's vite forwards
 * `/api/*` → bridge).
 *
 * Placement is BELOW the edge auth gate in `worker/index.ts` (dispatch order is
 * security-load-bearing): an unauthenticated request got `renderLogin()` already and never
 * reaches a bridge; the Inbox LIST (`inbox.ts`) stays edge-only and never wakes a runner.
 */
// A proxied chat SEND (`POST /api/chat/:chatId/send`) — the human answering. The proxy is the
// inbox-aware home for the triage flip; `<ChatView>` / the generic `/send` stay unaware of it.
const IS_CHAT_SEND = /^\/api\/chat\/[^/]+\/send$/;

export async function handleInboxBridge(
  request: Request,
  env: Env,
  user: GateUser,
  convId: string,
  subPath: string,
): Promise<Response> {
  const database = db(env);
  const conv = await conversations.get(database, convId);
  if (!conv || conv.userId !== user.id) return Response.json({ error: 'conversation not found' }, { status: 404 });

  // Inbox triage side-effect (ADR-0009 / #124): a reply is a chat SEND now (not the retired
  // /api/inbox/:id/reply), so flip the Conversation waiting_on:human → agent here — the same
  // transition (and unread-clear) `conversations.reply` always did — so answering un-pins it
  // from the attention list. ONLY on a send (not the transcript GET, the /chat id lookup, the
  // alive beat, or interrupt). Fire-and-forget + best-effort: a flip failure must never block
  // or break the proxied (SSE) send.
  if (request.method === 'POST' && IS_CHAT_SEND.test(subPath)) {
    void conversations.reply(database, convId).catch(() => {});
  }

  // Strip the routing prefix so only the bridge sub-path (query preserved) reaches the
  // container. `new Request(url, request)` is the CF-idiomatic URL rewrite — it carries the
  // method, headers, and the (streaming) body through unbuffered.
  const target = new URL(request.url);
  target.pathname = subPath;
  return serveWorkspace(new Request(target, request), env, coordsForWorkspace(conv.workspaceId));
}
