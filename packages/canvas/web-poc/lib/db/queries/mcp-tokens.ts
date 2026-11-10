import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { workspaceMcpTokens } from "../schema.js";

/**
 * External MCP tokens (ADR-0013 train 2, #176). Per-workspace owner consent to an
 * approved registry server (`server/mcp-registry.ts`): a pasted bearer token, stored
 * edge-side only. `listTokens` is what the proxy reads before attaching the per-send
 * header (`server/mcp-registry.ts`'s `MCP_TOKENS_HEADER`) — never persisted beyond here.
 */

/** Set (create or replace) a workspace's token for a registry server. */
export async function setToken(
  db: Database,
  workspaceId: string,
  mcpName: string,
  token: string,
): Promise<void> {
  const [updated] = await db
    .update(workspaceMcpTokens)
    .set({ token, updatedAt: new Date() })
    .where(and(eq(workspaceMcpTokens.workspaceId, workspaceId), eq(workspaceMcpTokens.mcpName, mcpName)))
    .returning();
  if (!updated) {
    await db.insert(workspaceMcpTokens).values({ workspaceId, mcpName, token });
  }
}

/** Clear (disconnect) a workspace's token for a registry server. No-op if unset. */
export async function clearToken(db: Database, workspaceId: string, mcpName: string): Promise<void> {
  await db
    .delete(workspaceMcpTokens)
    .where(and(eq(workspaceMcpTokens.workspaceId, workspaceId), eq(workspaceMcpTokens.mcpName, mcpName)));
}

/** Every token a workspace has connected, keyed by registry server name. Empty ⇒ not
 * connected to anything (the edge attaches no header, the container arms no server). */
export async function listTokens(db: Database, workspaceId: string): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(workspaceMcpTokens)
    .where(eq(workspaceMcpTokens.workspaceId, workspaceId));
  return Object.fromEntries(rows.map((r) => [r.mcpName, r.token]));
}
