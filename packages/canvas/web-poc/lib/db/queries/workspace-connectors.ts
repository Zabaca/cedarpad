import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type WorkspaceConnectorRow, workspaceConnectors } from "../schema.js";

/**
 * Workspace connectors (#241): the workspace's third-party connector
 * credentials (dlt sources for the warehouse pipeline, ADR-0017), one row
 * per connector name. Same encryption pattern as workspace_repos' PAT rows
 * (ADR-0016) — `encryptedSecret` is AES-GCM sealed at the edge, never
 * plaintext at rest.
 */

const newConnectorId = () => `wc_${crypto.randomUUID()}`;

/** All connectors of a workspace, oldest first. */
export async function listWorkspaceConnectors(db: Database, workspaceId: string): Promise<WorkspaceConnectorRow[]> {
  return await db
    .select()
    .from(workspaceConnectors)
    .where(eq(workspaceConnectors.workspaceId, workspaceId))
    .orderBy(asc(workspaceConnectors.createdAt), asc(workspaceConnectors.connectorName));
}

/** Set a connector's secret: inserts on first use, replaces the seal on rotation. */
export async function setWorkspaceConnector(
  db: Database,
  input: { workspaceId: string; connectorName: string; encryptedSecret: string; addedByUserId: string },
): Promise<WorkspaceConnectorRow> {
  const [row] = await db
    .insert(workspaceConnectors)
    .values({
      id: newConnectorId(),
      workspaceId: input.workspaceId,
      connectorName: input.connectorName,
      encryptedSecret: input.encryptedSecret,
      addedByUserId: input.addedByUserId,
    })
    .onConflictDoUpdate({
      target: [workspaceConnectors.workspaceId, workspaceConnectors.connectorName],
      set: { encryptedSecret: input.encryptedSecret, addedByUserId: input.addedByUserId },
    })
    .returning();
  if (!row) throw new Error("setWorkspaceConnector: insert returned no row");
  return row;
}

/** Remove a connector's credential entirely. */
export async function deleteWorkspaceConnector(
  db: Database,
  input: { workspaceId: string; connectorName: string },
): Promise<void> {
  await db
    .delete(workspaceConnectors)
    .where(and(eq(workspaceConnectors.workspaceId, input.workspaceId), eq(workspaceConnectors.connectorName, input.connectorName)));
}
