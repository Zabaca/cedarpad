import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/client.ts';
import {
  createShareLink,
  getActiveShareLink,
  listShareLinks,
  revokeShareLink,
} from '../web-poc/lib/db/queries/share-links.ts';
import type { GateUser } from './auth-gate.ts';
import { resolveCanvasWorkspace } from './access.ts';

// The member-facing half of the guest door (canvas ADR-0015, PRD #220): mint, list and
// revoke share links for a canvas. MEMBER-minted by design (not owner-only — collaborators
// share their own work; grill decision on #220). Access is checked through the canvas's
// workspace exactly like the pad route (`ownedCanvas` in worker/index.ts): a canvas the
// caller can't see is a 404, never a 403 — don't confirm existence to outsiders.

// `shapeId` set = component-scoped link (PRD #221): guest sees that one shape fullscreen,
// chat fully denied. guestChat is meaningless there and forced false at mint.
const MintInput = z.object({
  guestChat: z.boolean().default(false),
  /** Huddle capability (ADR-0017). Like guestChat, meaningless on component-scoped links. */
  guestHuddle: z.boolean().default(false),
  shapeId: z.string().min(1).optional(),
});

/**
 * POST   /api/canvases/:canvasId/share-links {guestChat?}  → 201 link
 * GET    /api/canvases/:canvasId/share-links               → 200 {links}
 * DELETE /api/canvases/:canvasId/share-links/:linkId       → 204 (revoke, tombstone)
 */
export async function handleShareLinksApi(
  request: Request,
  db: Database,
  user: GateUser,
  canvasId: string,
  linkId?: string,
): Promise<Response> {
  const workspaceId = await resolveCanvasWorkspace(db, canvasId, user.id);
  if (!workspaceId) return Response.json({ error: 'canvas not found' }, { status: 404 });

  if (request.method === 'POST' && !linkId) {
    const parsed = MintInput.safeParse((await request.json().catch(() => null)) ?? {});
    if (!parsed.success) return Response.json({ error: 'invalid body' }, { status: 400 });
    const link = await createShareLink(db, {
      canvasId,
      workspaceId,
      createdBy: user.id,
      guestChat: parsed.data.shapeId ? false : parsed.data.guestChat,
      guestHuddle: parsed.data.shapeId ? false : parsed.data.guestHuddle,
      shapeId: parsed.data.shapeId ?? null,
    });
    return Response.json(link, { status: 201 });
  }
  if (request.method === 'GET' && !linkId) {
    return Response.json({ links: await listShareLinks(db, canvasId) });
  }
  if (request.method === 'DELETE' && linkId) {
    // The link must belong to THIS canvas — a cross-canvas id is a 404, and an
    // already-revoked/unknown link revokes as a no-op (idempotent delete).
    const link = await getActiveShareLink(db, linkId);
    if (link && link.canvasId !== canvasId) return Response.json({ error: 'link not found' }, { status: 404 });
    await revokeShareLink(db, linkId);
    return new Response(null, { status: 204 });
  }
  return new Response('method not allowed', { status: 405 });
}
