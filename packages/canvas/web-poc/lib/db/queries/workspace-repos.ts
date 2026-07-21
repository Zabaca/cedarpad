import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../client.js";
import { type WorkspaceRepoRow, workspaceRepos, workspaces } from "../schema.js";

/**
 * Workspace repos (ADR-0016): the workspace's Repo assets, one row per repo.
 * Supersedes workspaces.selected_repos (the JSON array). The legacy column is
 * consumed lazily: the first list for a workspace that still carries it moves
 * each name into an 'installation' row and nulls the column, so a later
 * deselect-all can never resurrect the old value.
 */

const newRepoId = () => `wr_${crypto.randomUUID()}`;

/** All repos of a workspace, oldest first — backfilling the legacy JSON column once. */
export async function listWorkspaceRepos(db: Database, workspaceId: string): Promise<WorkspaceRepoRow[]> {
  const rows = await db
    .select()
    .from(workspaceRepos)
    .where(eq(workspaceRepos.workspaceId, workspaceId))
    .orderBy(asc(workspaceRepos.createdAt), asc(workspaceRepos.fullName));
  if (rows.length > 0) return rows;

  const [ws] = await db
    .select({ selectedRepos: workspaces.selectedRepos })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces.selectedRepos)))
    .limit(1);
  const legacy = ws?.selectedRepos ?? null;
  if (!legacy || legacy.length === 0) {
    if (legacy) await db.update(workspaces).set({ selectedRepos: null }).where(eq(workspaces.id, workspaceId));
    return [];
  }
  await db
    .insert(workspaceRepos)
    .values(legacy.map((fullName) => ({ id: newRepoId(), workspaceId, fullName, source: "installation" as const })))
    .onConflictDoNothing();
  await db.update(workspaces).set({ selectedRepos: null }).where(eq(workspaces.id, workspaceId));
  return await listWorkspaceRepos(db, workspaceId);
}

/** Add a PAT-backed repo. Throws on a duplicate full name (unique per workspace). */
export async function addPatRepo(
  db: Database,
  input: { workspaceId: string; fullName: string; encryptedToken: string; addedByUserId: string },
): Promise<WorkspaceRepoRow> {
  const [row] = await db
    .insert(workspaceRepos)
    .values({
      id: newRepoId(),
      workspaceId: input.workspaceId,
      fullName: input.fullName,
      source: "pat",
      encryptedToken: input.encryptedToken,
      addedByUserId: input.addedByUserId,
    })
    .returning();
  if (!row) throw new Error("addPatRepo: insert returned no row");
  return row;
}

/** Rotate a PAT repo's token in place (the "Update token…" flow). */
export async function updatePatRepoToken(
  db: Database,
  input: { workspaceId: string; fullName: string; encryptedToken: string },
): Promise<void> {
  await db
    .update(workspaceRepos)
    .set({ encryptedToken: input.encryptedToken })
    .where(
      and(
        eq(workspaceRepos.workspaceId, input.workspaceId),
        eq(workspaceRepos.fullName, input.fullName),
        eq(workspaceRepos.source, "pat"),
      ),
    );
}

/** Remove a PAT repo (its row and encrypted token). Installation rows are managed
 *  through replaceInstallationRepos / clearInstallationRepos only. */
export async function removePatRepo(db: Database, input: { workspaceId: string; fullName: string }): Promise<void> {
  await db
    .delete(workspaceRepos)
    .where(
      and(
        eq(workspaceRepos.workspaceId, input.workspaceId),
        eq(workspaceRepos.fullName, input.fullName),
        eq(workspaceRepos.source, "pat"),
      ),
    );
}

/** Replace the installation-sourced selection (the Settings checkbox set).
 *  PAT rows are untouched — they are separate connections. */
export async function replaceInstallationRepos(
  db: Database,
  input: { workspaceId: string; repos: string[] },
): Promise<void> {
  // Consume any legacy JSON first so this write is against rows, not the old column.
  await listWorkspaceRepos(db, input.workspaceId);
  await db
    .delete(workspaceRepos)
    .where(and(eq(workspaceRepos.workspaceId, input.workspaceId), eq(workspaceRepos.source, "installation")));
  if (input.repos.length > 0) {
    await db
      .insert(workspaceRepos)
      .values(
        input.repos.map((fullName) => ({
          id: newRepoId(),
          workspaceId: input.workspaceId,
          fullName,
          source: "installation" as const,
        })),
      )
      .onConflictDoNothing();
  }
}

/** Disconnecting the GitHub App installation: its rows go; PAT rows survive. */
export async function clearInstallationRepos(db: Database, workspaceId: string): Promise<void> {
  await db
    .delete(workspaceRepos)
    .where(and(eq(workspaceRepos.workspaceId, workspaceId), eq(workspaceRepos.source, "installation")));
}
