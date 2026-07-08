import { asc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type CanvasRow, canvases } from "../schema.js";

/**
 * Canvas registry (ADR-0007, PRD #48). The per-workspace, edge-queryable INDEX
 * of canvases — which canvases exist and their names. Canvas *state* lives in R2
 * (ADR-0001), never here. Backend only; nothing consumes it until slice #53.
 */

const newCanvasId = () => `cv_${crypto.randomUUID()}`;

/** Create a canvas in the given workspace. Returns the new row. */
export async function create(
  db: Database,
  input: { workspaceId: string; name: string },
): Promise<CanvasRow> {
  const [row] = await db
    .insert(canvases)
    .values({
      id: newCanvasId(),
      workspaceId: input.workspaceId,
      name: input.name,
    })
    .returning();
  if (!row) throw new Error("create: insert returned no row");
  return row;
}

/** List a workspace's canvases, oldest first. Scoped to the workspace. */
export async function list(db: Database, workspaceId: string): Promise<CanvasRow[]> {
  return db
    .select()
    .from(canvases)
    .where(eq(canvases.workspaceId, workspaceId))
    .orderBy(asc(canvases.createdAt));
}

/** Get a canvas by id, or null if it does not exist. */
export async function get(db: Database, canvasId: string): Promise<CanvasRow | null> {
  const [row] = await db.select().from(canvases).where(eq(canvases.id, canvasId)).limit(1);
  return row ?? null;
}

/** Rename a canvas. Returns the updated row, or null if it does not exist. */
export async function rename(
  db: Database,
  canvasId: string,
  name: string,
): Promise<CanvasRow | null> {
  const [row] = await db
    .update(canvases)
    .set({ name })
    .where(eq(canvases.id, canvasId))
    .returning();
  return row ?? null;
}

/** Delete a canvas from the registry (its R2 state is not touched here). */
export async function del(db: Database, canvasId: string): Promise<void> {
  await db.delete(canvases).where(eq(canvases.id, canvasId));
}

export { del as delete };
