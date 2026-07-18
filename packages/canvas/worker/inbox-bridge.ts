import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { get as getCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import { conversationHiddenFrom } from './visibility.ts';
import { listTokens } from '../web-poc/lib/db/queries/mcp-tokens.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { INBOX_ASSIGN_HEADER } from '../shared/chat-wire.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { MCP_TOKENS_HEADER, encodeMcpTokens } from '../server/mcp-registry.ts';
import type { GateUser } from './auth-gate.ts';
import { isDevAgentConversation } from '../server/dev-agent-workflow.ts';
import { mintDevAgentGitToken } from './github-app.ts';
import { resolveDevAgentRepo } from './github-connection.ts';
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
 * Resolve a Conversation's workspace to its owning runner's coordinates: the legacy
 * `default` id → the legacy/prod container; any other id → its derived per-workspace
 * container. (Dev-agent rows need no special case anymore — dev-agent is a Conversation
 * KIND now, and the rows live in the workspace they run in, i.e. `default`.)
 */
export const coordsForWorkspace = (workspaceId: string): SandboxCoords =>
  resolve(workspaceId === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE : { id: workspaceId });

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
  // Default-parameter test seams: production always mints/resolves for real; tests inject recorders.
  mint: typeof mintDevAgentGitToken = mintDevAgentGitToken,
  resolveRepo: typeof resolveDevAgentRepo = resolveDevAgentRepo,
): Promise<Response> {
  const database = db(env);
  const conv = await conversations.get(database, convId);
  // Membership gate (shared inbox, CONTEXT.md): any member of the Conversation's workspace
  // may read and reply — never creator-gated. A stranger gets the missing-row 404.
  if (!conv || !(await getWorkspace(database, conv.workspaceId, user.id))) {
    return Response.json({ error: 'conversation not found' }, { status: 404 });
  }
  // ADR-0016: a hidden conversation (its own private flag, or a private linked canvas —
  // canvas dominates) is the same 404 as a missing row, on every proxied sub-path.
  const linkedCanvas = conv.canvasId ? await getCanvas(database, conv.canvasId) : null;
  if (conversationHiddenFrom(conv, linkedCanvas, user.id)) {
    return Response.json({ error: 'conversation not found' }, { status: 404 });
  }

  const isChatSend = request.method === 'POST' && IS_CHAT_SEND.test(subPath);

  // Inbox triage side-effect (ADR-0009 / #124): a reply is a chat SEND now (not the retired
  // /api/inbox/:id/reply), so flip the Conversation waiting_on:human → agent here — the same
  // transition (and unread-clear) `conversations.reply` always did — so answering un-pins it
  // from the attention list. ONLY on a send (not the transcript GET, the /chat id lookup, the
  // alive beat, or interrupt). Fire-and-forget + best-effort: a flip failure must never block
  // or break the proxied (SSE) send.
  if (isChatSend) {
    void conversations.reply(database, convId).catch(() => {});
  }

  // Strip the routing prefix so only the bridge sub-path (query preserved) reaches the
  // container. `new Request(url, request)` is the CF-idiomatic URL rewrite — it carries the
  // method, headers, and the (streaming) body through unbuffered.
  const target = new URL(request.url);
  target.pathname = subPath;
  const proxied = new Request(target, request);

  // ADR-0010 → ADR-0015: a dev-agent Conversation's SEND — and only a send — carries a
  // freshly-minted, ~1h git token scoped to the conversation's OWN repo (`conv.repo`, the
  // run→repo edge stamped at run start; legacy rows without one fall back to the workspace's
  // first selected repo). The bridge arms `open_pr` for exactly that turn against exactly
  // that repo (`x-dev-agent-repo`). The App private key never leaves the edge (ADR-0008);
  // the token is per-turn, never env-injected, never persisted. Best-effort: a failed
  // resolve/mint proxies the send token-less rather than blocking the reply.
  if (isChatSend && isDevAgentConversation(conv)) {
    const resolved = await resolveRepo(env, database, conv.workspaceId, conv.repo ?? undefined);
    if (resolved) {
      proxied.headers.set('x-dev-agent-repo', resolved.repoFullName);
      const token = await mint(env, { nowSec: Math.floor(Date.now() / 1000), ...resolved });
      if (token) proxied.headers.set('x-dev-agent-git-token', token);
    }
  }

  // Shared-inbox assignment (CONTEXT.md): a SEND is a human act, so it carries its initiator —
  // the bridge assigns the Conversation at birth / claims-if-unassigned on a reply. Overwrites
  // any client-sent value (the gated user is the truth); reads never carry it.
  if (isChatSend) proxied.headers.set(INBOX_ASSIGN_HEADER, user.id);

  // Canvas pairing: the Inbox surface is not a pad, so its ChatView stamps no x-canvas-id.
  // A linked Conversation's SEND gets the stamp from its row instead, so the resumed turn
  // runs against the chat's own canvas store (the agent reads/draws the canvas it lives on).
  // Sends only — reads route by path, not by canvas claim.
  if (isChatSend && conv.canvasId) proxied.headers.set('x-canvas-id', conv.canvasId);

  // ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens ride a single JSON
  // header on the send — mirrors x-dev-agent-git-token above. `server/turn.ts` drops this for a
  // dev-agent turn regardless (chat flavor only), but no tokens connected ⇒ no header either way.
  if (isChatSend) {
    const tokens = await listTokens(database, conv.workspaceId);
    if (Object.keys(tokens).length > 0) proxied.headers.set(MCP_TOKENS_HEADER, encodeMcpTokens(tokens));
  }

  return serveWorkspace(proxied, env, coordsForWorkspace(conv.workspaceId));
}
