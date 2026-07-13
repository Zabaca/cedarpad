import { z } from 'zod';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { clearToken, setToken } from '../web-poc/lib/db/queries/mcp-tokens.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE_ID } from './shell-routing.ts';

// The owner-consent half of ADR-0013 train 2 (#176): a minimal edge API (no UI yet) for a
// workspace owner to connect/disconnect a registry MCP server by pasting/clearing its bearer
// token. Storage is `web-poc/lib/db/queries/mcp-tokens.ts`; the token itself never touches this
// module beyond validating the request body — it's handed straight to the query layer, and
// read back out only by the proxy that attaches it to a chat send (worker/inbox-bridge.ts,
// worker/index.ts) via `server/mcp-registry.ts`'s shared header contract.

// Single contract for this API's body (CLAUDE.md §7).
const SetTokenInput = z.object({ token: z.string().trim().min(1) });

/** Ownership check mirroring `worker/index.ts`'s `ownedCanvas` pattern: the legacy `default`
 * workspace needs no registry row; any other id must be owned by the caller. */
async function ownsWorkspace(env: Env, workspaceId: string, user: GateUser): Promise<boolean> {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return true;
  const ws = await getWorkspace(createDbForWorker(env as unknown as Bindings), workspaceId, user.id);
  return ws !== null;
}

/**
 * PUT   /api/workspaces/:workspaceId/mcp/:mcpName/token {token} → 204 (connect/replace)
 * DELETE /api/workspaces/:workspaceId/mcp/:mcpName/token         → 204 (disconnect)
 * A workspace the caller doesn't own (and isn't `default`) is 404 — same shape as every
 * other ownership-checked edge route.
 */
export async function handleMcpTokenApi(
  request: Request,
  env: Env,
  user: GateUser,
  workspaceId: string,
  mcpName: string,
): Promise<Response> {
  if (!(await ownsWorkspace(env, workspaceId, user))) {
    return Response.json({ error: 'workspace not found' }, { status: 404 });
  }
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
