import type { Database } from '../web-poc/lib/db/client.ts';
import { conversations } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import { type ConversationStartOutput, PlatformRpcRequest, type TurnEndOutput, verifyPlatformRpcToken } from '../shared/platform-rpc.ts';
import type { Env } from './index.ts';
import { makeAssignmentPushNotify, type PushSend, webPushSender } from './push-notify.ts';

// The edge half of the platform RPC (ADR-0018). See `shared/platform-rpc.ts` for the contract
// and for why this is a behavioural surface rather than a data-access one.

/** The collaborators the operations need. Default-parameter seam (as `bridge.ts` uses), so
 * tests drive the real handler against an in-memory platform data layer. */
export interface PlatformRpcDeps {
  db: Database;
  /** The push transport; null when VAPID is unconfigured (push simply off). */
  send: PushSend | null;
  /** Shell origin a notification click should open. */
  origin: string;
}

/** The production wiring, minus the platform-data-layer client (the caller passes the one the
 * edge already builds — this module stays free of `web-poc/worker/runtime.ts`, so a bun test
 * can import it without the workerd-only libSQL client coming along). */
export function platformRpcDeps(env: Env, db: Database): PlatformRpcDeps {
  return {
    db,
    send: webPushSender(env as unknown as Record<string, string | undefined>),
    origin: (env.WEB_ORIGIN ?? '').replace(/\/$/, ''),
  };
}

/** Bearer check: the caller must present the token derived from the shared trust root. */
async function authorized(request: Request, env: Env): Promise<boolean> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return false;
  const presented = request.headers.get('authorization')?.replace(/^Bearer /, '');
  return !!presented && (await verifyPlatformRpcToken(secret, presented));
}

/** `POST /api/platform-rpc` — the two named operations, nothing else. */
export async function handlePlatformRpc(request: Request, env: Env, deps: PlatformRpcDeps): Promise<Response> {
  if (!(await authorized(request, env))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // Parse at the boundary (CLAUDE.md §7): an unparseable body is a contract violation, not a
  // dispatchable operation.
  const parsed = PlatformRpcRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'invalid request' }, { status: 400 });

  if (parsed.data.op === 'conversation.start') {
    const conv = await findOrCreateConversation(deps.db, parsed.data.input);
    return Response.json({ conversationId: conv.id } satisfies ConversationStartOutput);
  }

  // The settle-time backstop (#266): find-or-create by CHAT — the same call the start made, so
  // a settle after a start touches the one row rather than racing a second into existence —
  // then mark it active so an `end_turn`-less turn still surfaces in "All".
  if (parsed.data.op === 'conversation.settle') {
    const conv = await findOrCreateConversation(deps.db, parsed.data.input);
    await conversations.markActivity(deps.db, conv.id);
    return new Response(null, { status: 200 });
  }

  // `end_turn` (ADR-0012 / #266): the turn declares its ending and the EDGE owns the row
  // transition. The container gets back only the id, which is the handle it then names in
  // `notify` — it never learns the row.
  if (parsed.data.op === 'turn.end') {
    const { outcome, question, summary, ...identity } = parsed.data.input;
    const conv = await findOrCreateConversation(deps.db, { ...identity, summary });
    if (outcome === 'done') await conversations.markDone(deps.db, conv.id, summary);
    else await conversations.promote(deps.db, conv.id, question ?? summary);
    return Response.json({ conversationId: conv.id } satisfies TurnEndOutput);
  }

  const { conversationId, question } = parsed.data.input;
  const conv = await conversations.get(deps.db, conversationId);
  // Push is the doorbell, not the signal: an unknown Conversation or unconfigured VAPID
  // simply means no ping (the Inbox row is already the durable record).
  if (conv && deps.send) {
    await makeAssignmentPushNotify({ db: deps.db, origin: deps.origin, send: deps.send })(conv, question);
  }
  return new Response(null, { status: 200 });
}
