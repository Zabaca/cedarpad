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
/** The workspace's effective connected tokens: stored rows, plus the env fallback for the
 *  DEFAULT workspace only (mirroring the GitHub installation fallback, github-connection.ts):
 *  FREDRIN_KEY / FREDRIN_<LABEL>_KEY provisioned as worker secrets connect `fredrin` /
 *  `fredrin-<label>` there until a real per-workspace token row exists — a stored row wins. */
/** The env half: FREDRIN_KEY connects `fredrin`, and each FREDRIN_<LABEL>_KEY a named
 *  `fredrin-<label>` connection (one per Fredrin project key — server/mcp-registry.ts). */
function envFredrinTokens(env: Env): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const m = /^FREDRIN(?:_([A-Z0-9]+(?:_[A-Z0-9]+)*))?_KEY$/.exec(name);
    if (m && typeof value === 'string' && value) tokens[m[1] ? `fredrin-${m[1].toLowerCase().replaceAll('_', '-')}` : 'fredrin'] = value;
  }
  return tokens;
}

export async function effectiveMcpTokens(env: Env, workspaceId: string): Promise<Record<string, string>> {
  const stored = await listTokens(createDbForWorker(env), workspaceId);
  return workspaceId === 'default' ? { ...envFredrinTokens(env), ...stored } : stored;
}

export async function withMcpTokensHeader(request: Request, env: Env, workspaceId: string): Promise<Request> {
  const tokens = await effectiveMcpTokens(env, workspaceId);
  if (Object.keys(tokens).length === 0) return request;
  const proxied = new Request(request.url, request);
  proxied.headers.set(MCP_TOKENS_HEADER, encodeMcpTokens(tokens));
  return proxied;
}
