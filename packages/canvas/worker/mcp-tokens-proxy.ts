import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { listTokens } from '../web-poc/lib/db/queries/mcp-tokens.ts';
import { MCP_TOKENS_HEADER, encodeMcpTokens } from '../server/mcp-registry.ts';
import type { Env } from './index.ts';

/** A proxied chat SEND (`POST /api/chat/:id/send`) — the one request kind the workspace's
 * external-MCP token attaches to. Shared by both proxy points: the general same-origin
 * fallthrough (worker/index.ts) and the Inbox chat proxy (worker/inbox-bridge.ts). */
export const IS_CHAT_SEND = /^\/api\/chat\/[^/]+\/send$/;

/**
 * Attach the workspace's connected MCP tokens (ADR-0013 train 2, #176) as a single JSON
 * header on a proxied chat SEND — mirrors the ADR-0010 dev-agent-git-token pattern: edge
 * custody, a per-send header, never persisted container-side. No connected tokens ⇒ the
 * request passes through untouched (no header, no connection attempt).
 */
export async function withMcpTokensHeader(request: Request, env: Env, workspaceId: string): Promise<Request> {
  const stored = await listTokens(createDbForWorker(env as unknown as Bindings), workspaceId);
  // Env fallback for the DEFAULT workspace only, mirroring the GitHub installation fallback
  // (github-connection.ts): FREDRIN_KEY provisioned as a worker secret connects `fredrin`
  // there until a real per-workspace token row exists — a stored row wins over the env.
  const tokens =
    workspaceId === 'default' && env.FREDRIN_KEY ? { fredrin: env.FREDRIN_KEY, ...stored } : stored;
  if (Object.keys(tokens).length === 0) return request;
  const proxied = new Request(request.url, request);
  proxied.headers.set(MCP_TOKENS_HEADER, encodeMcpTokens(tokens));
  return proxied;
}
