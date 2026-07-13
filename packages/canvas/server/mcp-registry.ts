// External MCP registry (ADR-0013 train 2, #176): the code-side, PR-gated catalog of
// approved remote HTTP MCP servers the agent may consume. Adding an entry is a PR — that
// IS the capability gate (docs/adr/0013-mcp-and-workspace-content-are-the-integration-seam.md).
//
// Enablement is separate from the registry: a workspace owner pastes a per-workspace bearer
// token (worker/index.ts's mcp-token API + `web-poc/lib/db/queries/mcp-tokens.ts`), which the
// edge attaches as a header on the proxied `/send` (worker/inbox-bridge.ts, worker/index.ts) —
// never persisted container-side. `server/agent.ts` builds this turn's `mcpServers` option from
// whichever registry entries the request's token header actually names. This module is the
// SHARED CONTRACT for that header (single-contract guideline): the worker encodes it, the
// bridge decodes it — one shape, both sides.
import { z } from 'zod';

/** v1 is bearer-only (a pasted per-workspace token); a registry entry may later declare
 * `auth: 'oauth'` (each workspace does its own OAuth dance) — the shape anticipates it. */
export type McpAuthKind = 'bearer';

export interface McpRegistryEntry {
  url: string;
  auth: McpAuthKind;
}

/** The approved remote MCP servers. A missing token/env for an entry means "not connected" —
 * never a failure — so an entry only appears here once it has somewhere to point.
 *
 * `ledgerbot` (zabaca/ceo, the ADR's first consumer): guarded by its own URL env var so an
 * unconfigured deploy simply has no ledgerbot entry (not a broken one). */
export const MCP_REGISTRY: Readonly<Record<string, McpRegistryEntry>> = {
  ...(process.env.LEDGERBOT_MCP_URL ? { ledgerbot: { url: process.env.LEDGERBOT_MCP_URL, auth: 'bearer' } } : {}),
};

/** The proxied `/send` header carrying a workspace's connected tokens, keyed by registry
 * server name — the edge's whole answer to "which servers is this workspace enabled for,
 * and with what token" for this turn. A single JSON header (not one-per-server) keeps the
 * contract to one shape instead of an open-ended set of header names. */
export const MCP_TOKENS_HEADER = 'x-mcp-tokens';

export const McpTokensSchema = z.record(z.string(), z.string());
export type McpTokens = z.infer<typeof McpTokensSchema>;

/** Encode a workspace's connected tokens onto the header value (edge-side). */
export function encodeMcpTokens(tokens: McpTokens): string {
  return JSON.stringify(tokens);
}

/** Decode + validate the header value (container-side). Any malformed/missing header decodes
 * to "no tokens" rather than failing the turn — an unreachable/misconfigured server degrades
 * the turn's toolset, it never fails the turn. */
export function decodeMcpTokens(raw: string | null | undefined): McpTokens {
  if (!raw) return {};
  try {
    const parsed = McpTokensSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
