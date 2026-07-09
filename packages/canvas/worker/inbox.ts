import { AwsClient } from 'aws4fetch';
import * as conversations from '../web-poc/lib/db/queries/conversations.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { type BlobGetter, read as readTranscript } from '../server/transcript-r2.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { orderInbox } from './inbox-view.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';

// The edge Inbox API (ADR-0007, PRD #50 slice #62). The user-scoped attention inbox,
// served AT THE EDGE against remote Turso + R2 — so listing a Conversation and reading
// its history never wakes a container (the runner can sleep). Only a reply wakes it, by
// forwarding to the container bridge's `/api/inbox/:id/reply` (#61), which restores +
// resumes the SDK Session. The PURE list-ordering + R2 key/URL derivation live here too,
// unit-tested without the edge runtime.

const db = (env: Env) => createDbForWorker(env as unknown as Bindings);

/**
 * The edge's `BlobGetter` (#60 left this seam for us): an S3 GET against R2 with SigV4
 * (`aws4fetch` — `Bun.S3Client` is container-only). A 404 is a legitimately-absent
 * transcript → null; any other non-2xx throws. So the Inbox reads history straight from
 * R2 while the runner sleeps.
 */
export function edgeBlobGetter(env: Env): BlobGetter {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  return {
    async get(key: string): Promise<Uint8Array | null> {
      const url = `${env.R2_ENDPOINT.replace(/\/$/, '')}/${env.R2_BUCKET}/${key}`;
      const res = await aws.fetch(url, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * The edge Inbox API, user-scoped from the authenticated session:
 *   GET  /api/inbox                 → { items: InboxItem[] }  (filters: status, workspace)
 *   GET  /api/inbox/:id             → { conversation, events } (transcript read from R2)
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
    const statusParam = url.searchParams.get('status');
    const status = statusParam === 'open' || statusParam === 'closed' ? statusParam : undefined;
    const workspaceId = url.searchParams.get('workspace') ?? undefined;
    const rows = await conversations.list(database, user.id, { status, workspaceId });
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

  // Detail: the Conversation + its transcript, read from R2 (works while the runner sleeps).
  if (request.method === 'GET') {
    const events = await readTranscript(edgeBlobGetter(env), conv.sessionId);
    return Response.json({ conversation: conv, events });
  }
  return new Response('method not allowed', { status: 405 });
}
