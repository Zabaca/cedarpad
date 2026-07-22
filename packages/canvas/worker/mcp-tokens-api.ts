import { z } from 'zod';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { clearToken, setToken } from '../web-poc/lib/db/queries/mcp-tokens.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';

// The owner-consent half of ADR-0013 train 2 (#176): a minimal edge API (no UI yet) for a
// workspace owner to connect/disconnect a registry MCP server by pasting/clearing its bearer
// token. Storage is `web-poc/lib/db/queries/mcp-tokens.ts`; the token itself never touches this
// module beyond validating the request body — it's handed straight to the query layer, and
// read back out only by the proxy that attaches it to a chat send (worker/inbox-bridge.ts,
// worker/index.ts) via `server/mcp-registry.ts`'s shared header contract.

// Single contract for this API's body (CLAUDE.md §7).
const SetTokenInput = z.object({ token: z.string().trim().min(1) });

/** OWNER-only access (#179/#181): connecting a token is workspace ADMIN, like inviting —
 * mirrors handleInvitationsApi. The lookup is access-checked (owner-OR-member since #181),
 * so the owner column decides the rest. `default` has a real seeded row — no bypass; a
 * missing row fails closed. */
async function workspaceAccess(env: Env, workspaceId: string, user: GateUser): Promise<'owner' | 'member' | 'none'> {
  const ws = await getWorkspace(createDbForWorker(env as unknown as Bindings), workspaceId, user.id);
  if (!ws) return 'none';
  return ws.ownerUserId === user.id ? 'owner' : 'member';
}

/**
 * PUT   /api/workspaces/:workspaceId/mcp/:mcpName/token {token} → 204 (connect/replace)
 * DELETE /api/workspaces/:workspaceId/mcp/:mcpName/token         → 204 (disconnect)
 * Owner-only admin: a member gets 403; a workspace the caller can't see at all is 404 —
 * the same shape as the invitations API (worker/invitations.ts).
 */
export async function handleMcpTokenApi(
  request: Request,
  env: Env,
  user: GateUser,
  workspaceId: string,
  mcpName: string,
): Promise<Response> {
  const access = await workspaceAccess(env, workspaceId, user);
  if (access === 'none') return Response.json({ error: 'workspace not found' }, { status: 404 });
  if (access === 'member') return Response.json({ error: 'owner only' }, { status: 403 });
  const db = createDbForWorker(env as unknown as Bindings);
  if (request.method === 'PUT') {
    const parsed = SetTokenInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid token' }, { status: 400 });
    await setToken(db, workspaceId, mcpName, parsed.data.token);
    return new Response(null, { status: 204 });
  }
  if (request.method === 'DELETE') {
    await clearToken(db, workspaceId, mcpName);
    return new Response(null, { status: 204 });
  }
  return new Response('method not allowed', { status: 405 });
}

/**
 * The member-readable half (per-chat MCP selection UI):
 *   GET /api/workspaces/:id/mcp               → { servers: [{name, connected}] }
 *   GET /api/workspaces/:id/mcp/:name/tools   → { tools: [{name, description?}] }
 * Reads grant nothing (the token never leaves the edge — only tool NAMES are returned),
 * so any workspace member may call them; the chat UI uses them to render checkboxes.
 */
export async function handleMcpReadApi(
  request: Request,
  env: Env,
  user: GateUser,
  workspaceId: string,
  deps: {
    registry: Readonly<Record<string, { url: string }>>;
    tokens: (env: Env, workspaceId: string) => Promise<Record<string, string>>;
    probeTools: (url: string, token: string) => Promise<Array<{ name: string; description?: string }>>;
  },
  mcpName?: string,
): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const access = await workspaceAccess(env, workspaceId, user);
  if (access === 'none') return Response.json({ error: 'workspace not found' }, { status: 404 });
  const tokens = await deps.tokens(env, workspaceId);

  if (!mcpName) {
    const servers = Object.keys(deps.registry).map((name) => ({ name, connected: !!tokens[name] }));
    return Response.json({ servers });
  }
  const entry = deps.registry[mcpName];
  if (!entry) return Response.json({ error: 'unknown server' }, { status: 404 });
  const token = tokens[mcpName];
  if (!token) return Response.json({ error: `${mcpName} is not connected` }, { status: 409 });
  try {
    return Response.json({ tools: await deps.probeTools(entry.url, token) });
  } catch (e: unknown) {
    console.error(`[mcp] tool probe failed for ${mcpName}: ${String(e)}`);
    return Response.json({ error: `could not list ${mcpName} tools` }, { status: 502 });
  }
}
