import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import { resolveConversationById } from './access.ts';
import { listTokens } from '../web-poc/lib/db/queries/mcp-tokens.ts';
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
import { DEFAULT_CANVAS_ID, DEFAULT_WORKSPACE_ID } from './shell-routing.ts';
import {
  CANVAS_ID_HEADER,
  CANVAS_VIEWER_HEADER,
  DEV_AGENT_GIT_TOKEN_HEADER,
  DEV_AGENT_REPO_HEADER,
  INBOX_CONVERSATION_HEADER,
  INBOX_PAIRING_HEADER,
  encodeForwardedConversation,
  encodeForwardedPairing,
} from '../shared/bridge-wire.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';

// The edge chat proxy (ADR-0009, PRD #119 slice #122). Under "one chat system" every chat
// surface is a LIVE VIEW of its session's runner bridge; a Shell-mounted <ChatView> points
// its `chat-store` connection-target prefix at `/inbox/:convId/bridge` so its stream + send +
// interrupt + transcript + `/api/alive` all address the Conversation's OWNING bridge instead
// of same-origin. This module owns that resolution (`conv.workspaceId → coords`) and the
// proxy, kept SEPARATE from the edge Inbox list/detail API (`inbox.ts`) so the Worker's test
// can exercise the real proxy while still stubbing that D1/R2-backed list handler.

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
// The open-conversation GET (`GET /api/inbox/:convId/chat`) — the Shell resolving a thread to
// its chatId. ADR-0018 / #261: the edge already holds the row, so it forwards it here.
const IS_OPEN_CONVERSATION = /^\/api\/inbox\/[^/]+\/chat$/;
// Canvas pairing (`POST /api/inbox/:convId/attach-canvas`). ADR-0018 / #264: the ROW half runs
// here; the container keeps only the card placement.
const IS_ATTACH_CANVAS = /^\/api\/inbox\/[^/]+\/attach-canvas$/;

export type PairingResult =
  | { ok: true; canvasId: string }
  | { ok: false; error: 'not_found' | 'already_linked' | 'wrong_workspace' };

/**
 * The row half of canvas pairing (#264, was `attachConversationToCanvas`'s first half): pick the
 * canvas and write the Conversation→canvas edge. `canvasId` given → that existing canvas,
 * SAME-WORKSPACE ONLY (the legacy `default` canvas has no registry row but belongs to every
 * workspace); omitted → create one in the Conversation's workspace, named from the chat summary.
 * First-wins: an already-linked Conversation is refused (no detach in v1).
 */
export async function pairConversationWithCanvas(
  database: Database,
  conv: ConversationRow,
  requestedCanvasId: string | undefined,
): Promise<PairingResult> {
  if (conv.canvasId) return { ok: false, error: 'already_linked' };

  let canvasId = requestedCanvasId;
  if (canvasId) {
    if (canvasId !== DEFAULT_CANVAS_ID) {
      const target = await canvasRegistry.get(database, canvasId);
      if (!target) return { ok: false, error: 'not_found' };
      if (target.workspaceId !== conv.workspaceId) return { ok: false, error: 'wrong_workspace' };
    }
  } else {
    const name = (conv.summary ?? '').trim().slice(0, 60) || 'Canvas';
    canvasId = (await canvasRegistry.create(database, { workspaceId: conv.workspaceId, name })).id;
  }

  await conversations.attachCanvas(database, conv.id, canvasId);
  return { ok: true, canvasId };
}

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
  // Membership gate (shared inbox, CONTEXT.md): any member of the Conversation's workspace
  // may read and reply — never creator-gated. ADR-0016: a hidden conversation (its own
  // private flag, or a private linked canvas — canvas dominates) is the same 404 as a
  // missing row, on every proxied sub-path. Both legs composed in access.ts.
  const conv = await resolveConversationById(database, convId, user.id);
  if (!conv) {
    return Response.json({ error: 'conversation not found' }, { status: 404 });
  }

  const isChatSend = request.method === 'POST' && IS_CHAT_SEND.test(subPath);
  const isOpenConversation = request.method === 'GET' && IS_OPEN_CONVERSATION.test(subPath);
  const isAttachCanvas = request.method === 'POST' && IS_ATTACH_CANVAS.test(subPath);
  // #264: attach-canvas is the one proxied path the edge READS the body of (to learn which
  // canvas was asked for), so it is buffered here and re-attached to the proxied request.
  const attachBody = isAttachCanvas ? await request.text() : null;

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
  const proxied =
    attachBody === null
      ? new Request(target, request)
      : new Request(target, { method: request.method, headers: request.headers, body: attachBody });

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
      proxied.headers.set(DEV_AGENT_REPO_HEADER, resolved.repoFullName);
      const token = await mint(env, { nowSec: Math.floor(Date.now() / 1000), ...resolved });
      if (token) proxied.headers.set(DEV_AGENT_GIT_TOKEN_HEADER, token);
    }
  }

  // Shared-inbox assignment (CONTEXT.md): a SEND is a human act, so it carries its initiator —
  // the bridge assigns the Conversation at birth / claims-if-unassigned on a reply. Overwrites
  // any client-sent value (the gated user is the truth); reads never carry it.
  if (isChatSend) proxied.headers.set(INBOX_ASSIGN_HEADER, user.id);

  // WHOSE SCREEN a turn started here may move (presentation only — see CANVAS_VIEWER_HEADER).
  // SET-OR-DELETE, the same discipline as the two headers below: this proxy returns before
  // worker/index.ts's strip-and-stamp block, so without the delete a client-sent value rode
  // straight through and a member could point `select_page` at a COLLEAGUE's open canvas.
  // Deliberately separate from INBOX_ASSIGN_HEADER above even though both are `user.id`:
  // that one answers who OWNS the conversation and is free to diverge, and a change to
  // assignment must never become a change to whose screen an agent can move.
  proxied.headers.delete(CANVAS_VIEWER_HEADER);
  if (isChatSend) proxied.headers.set(CANVAS_VIEWER_HEADER, user.id);

  // Canvas pairing: the Inbox surface is not a pad, so its ChatView stamps no x-canvas-id.
  // A linked Conversation's SEND gets the stamp from its row instead, so the resumed turn
  // runs against the chat's own canvas store (the agent reads/draws the canvas it lives on).
  // Sends only — reads route by path, not by canvas claim.
  if (isChatSend && conv.canvasId) proxied.headers.set(CANVAS_ID_HEADER, conv.canvasId);

  // ADR-0018 / #261: the open-conversation GET carries the Conversation the edge just resolved
  // and ownership-checked, so the bridge serves the route without reading the platform data
  // layer. Set-or-DELETE: a client-sent header must never survive into the container.
  proxied.headers.delete(INBOX_CONVERSATION_HEADER);
  if (isOpenConversation) {
    // Opening a thread is reading it, not activity. Fire-and-forget + best-effort, exactly as
    // the bridge did before: a failed clear must never block opening the chat.
    void conversations.markRead(database, convId).catch(() => {});
    proxied.headers.set(
      INBOX_CONVERSATION_HEADER,
      encodeForwardedConversation({ id: conv.id, sessionId: conv.sessionId, ownerRef: conv.ownerRef }),
    );
  }

  // ADR-0018 / #264: canvas pairing's row work happens HERE — link the Conversation to the
  // requested canvas (same-workspace only) or create one in its workspace — and the result rides
  // to the container, which only places the chat card. A refusal never wakes the runner. Same
  // set-or-DELETE discipline as above: a client-sent header must never survive.
  proxied.headers.delete(INBOX_PAIRING_HEADER);
  if (isAttachCanvas) {
    const body = ((): { canvasId?: unknown } => {
      try {
        return JSON.parse(attachBody || '{}') as { canvasId?: unknown };
      } catch {
        return {};
      }
    })();
    const requested = typeof body.canvasId === 'string' && body.canvasId ? body.canvasId : undefined;
    const pairing = await pairConversationWithCanvas(database, conv, requested);
    if (!pairing.ok) {
      const status = pairing.error === 'not_found' ? 404 : pairing.error === 'already_linked' ? 409 : 400;
      return Response.json({ error: pairing.error }, { status });
    }
    proxied.headers.set(
      INBOX_PAIRING_HEADER,
      encodeForwardedPairing({
        id: conv.id,
        sessionId: conv.sessionId,
        ownerRef: conv.ownerRef,
        canvasId: pairing.canvasId,
        summary: conv.summary,
      }),
    );
  }

  // ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens ride a single JSON
  // header on the send — mirrors x-dev-agent-git-token above. `server/turn.ts` drops this for a
  // dev-agent turn regardless (chat flavor only), but no tokens connected ⇒ no header either way.
  if (isChatSend) {
    const tokens = await listTokens(database, conv.workspaceId);
    if (Object.keys(tokens).length > 0) proxied.headers.set(MCP_TOKENS_HEADER, encodeMcpTokens(tokens));
  }

  return serveWorkspace(proxied, env, coordsForWorkspace(conv.workspaceId));
}
