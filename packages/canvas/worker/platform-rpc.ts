import type { Database } from '../web-poc/lib/db/client.ts';
import { conversations } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { getWorkspaceRecord } from '../web-poc/lib/db/queries/workspaces.ts';
import {
  type ComponentHistoryOutput,
  type ComponentReadOutput,
  type ComponentWriteOutput,
  type ConversationStartOutput,
  type DataReadOutput,
  type DataWriteOutput,
  PlatformRpcRequest,
  type SkillListOutput,
  type SkillWriteOutput,
  type TurnEndOutput,
  verifyPlatformRpcToken,
} from '../shared/platform-rpc.ts';
import { componentStore } from './component-store.ts';
import { dataStore } from './data-store.ts';
import type { Env } from './index.ts';
import { makeAssignmentPushNotify, type PushSend, webPushSender } from './push-notify.ts';
import { d1RecordStore } from './record-store.ts';
import { d1SkillFileStore } from './skill-file-store.ts';
import { skillStore } from './skill-store.ts';
import { DEFAULT_CANVAS_ID, DEFAULT_WORKSPACE_ID } from './shell-routing.ts';

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

/**
 * Ownership for a Record write (ADR-0022): the named canvas must actually belong to the
 * named workspace. The container says which workspace it is writing for; the EDGE decides
 * whether that is true, because a payload the container composes cannot be its own
 * authorization. The legacy `default` canvas has no registry row and is therefore pinned to
 * the legacy `default` workspace by hand.
 */
async function canvasBelongsToWorkspace(db: Database, workspaceId: string, canvasId: string): Promise<boolean> {
  if (canvasId === DEFAULT_CANVAS_ID) return workspaceId === DEFAULT_WORKSPACE_ID;
  const row = await canvasRegistry.get(db, canvasId);
  return row?.workspaceId === workspaceId;
}

/**
 * Ownership for a WORKSPACE-SCOPED Record write (ADR-0022) — Workspace skills (#361), which
 * have no canvas to contain them. With only one coordinate there is no containment to check,
 * so the check is that the workspace is REAL: the container names the workspace it is writing
 * for, and a forged or typo'd id must not quietly mint rows nobody can ever reach.
 *
 * NOTE FOR REVIEW: #359 introduces the same question for the shared Component tier
 * (`canvasId: null`). If it grew its own rule, these two should become one.
 *
 * The legacy `default` workspace has no `workspaces` row (it predates the registry, exactly as
 * the legacy `default` canvas does) and is therefore pinned by hand, like `canvasBelongsToWorkspace`.
 */
async function workspaceExists(db: Database, workspaceId: string): Promise<boolean> {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return true;
  return (await getWorkspaceRecord(db, workspaceId)) !== null;
}

/** `POST /api/platform-rpc` — the named operations, nothing else. */
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

  // The run opened a PR (CONTEXT.md "Open PR"): find-or-create by chat exactly as a settle
  // does — a PR can be the first thing a turn reports — then stamp the url. The row is what
  // the Inbox renders its Merge action from; the container never learns it.
  if (parsed.data.op === 'conversation.prOpened') {
    const { prUrl, ...identity } = parsed.data.input;
    const conv = await findOrCreateConversation(deps.db, identity);
    await conversations.recordPr(deps.db, conv.id, prUrl);
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

  // The Record verbs (ADR-0022). Validation already happened in the parse above — the name
  // rule and the non-empty rule are IN the contract, so a bad payload is a 400 here and never
  // something the store has to be trusted to catch. What is left is ownership, then the write.
  if (parsed.data.op === 'component.write') {
    const { workspaceId, canvasId, userId, name, source } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    // Deliberately NOT caught: a store failure must reach the container as a non-2xx so the
    // tool call fails and the agent retries. Swallowing it here is the 2026-07-29 shape.
    const { rev } = await componentStore(d1RecordStore(deps.db)).write({ workspaceId, canvasId, name, source, userId });
    return Response.json({ rev } satisfies ComponentWriteOutput);
  }

  if (parsed.data.op === 'component.read') {
    const { workspaceId, canvasId, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const source = await componentStore(d1RecordStore(deps.db)).read({ workspaceId, canvasId, name });
    return Response.json({ source } satisfies ComponentReadOutput);
  }

  // "Who changed this Component, and when" — the question nothing in this product could
  // answer before Records. Gated by the same ownership check as a read, because a history is
  // a read: the names in it are members of the workspace that owns the canvas.
  if (parsed.data.op === 'component.history') {
    const { workspaceId, canvasId, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const versions = await componentStore(d1RecordStore(deps.db)).history({ workspaceId, canvasId, name });
    return Response.json({ versions } satisfies ComponentHistoryOutput);
  }

  // The Workspace-skill verbs (#361). Same rules as the Component pair above — the contract
  // already rejected a bad skill name or file path with a 400, so what is left is ownership,
  // then the write — and the same deliberate absence of a try/catch: a store failure must
  // reach the container as a non-2xx so `upload_skill` fails and its caller can retry.
  if (parsed.data.op === 'skill.write') {
    const { workspaceId, userId, skill, files } = parsed.data.input;
    if (!(await workspaceExists(deps.db, workspaceId))) return Response.json({ error: 'forbidden' }, { status: 403 });
    const written = await skillStore(d1SkillFileStore(deps.db)).write({ workspaceId, skill, userId, files });
    return Response.json(written satisfies SkillWriteOutput);
  }

  // The whole tree, because that is what the SDK's filesystem discovery needs rendered before
  // a turn begins (server/skills.ts materializes it).
  if (parsed.data.op === 'skill.list') {
    const { workspaceId } = parsed.data.input;
    if (!(await workspaceExists(deps.db, workspaceId))) return Response.json({ error: 'forbidden' }, { status: 403 });
    const files = await skillStore(d1SkillFileStore(deps.db)).tree(workspaceId);
    return Response.json({ files } satisfies SkillListOutput);
  }

  // The data-file verbs. Same shape as the Component ones — the name and the size cap are in
  // the contract, so what is left here is ownership, then the write — plus the one rule the
  // contract cannot express: a `.json` that does not parse (the store checks it).
  if (parsed.data.op === 'data.write') {
    const { workspaceId, canvasId, userId, name, source } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    try {
      const { rev } = await dataStore(d1RecordStore(deps.db)).write({ workspaceId, canvasId, name, source, userId });
      return Response.json({ rev } satisfies DataWriteOutput);
    } catch (e) {
      // A content rule the caller can fix (unparseable JSON) is a 400 with the reason; a
      // store failure is NOT caught, so it reaches the container as a 5xx and fails the tool
      // call. Swallowing that is the 2026-07-29 shape.
      if (e instanceof Error && /not valid JSON/.test(e.message)) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
  }

  if (parsed.data.op === 'data.read') {
    const { workspaceId, canvasId, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const source = await dataStore(d1RecordStore(deps.db)).read({ workspaceId, canvasId, name });
    return Response.json({ source } satisfies DataReadOutput);
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
