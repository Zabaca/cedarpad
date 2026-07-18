import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/index.ts';
import {
  addWorkspaceMember,
  getWorkspace,
  listWorkspaceMembers,
  removeWorkspaceMember,
  transferWorkspaceOwnership,
} from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';

// Workspace roster (#192, Settings stage). Reading is workspace-visible (owner OR
// member — the roster is not a secret inside the trust boundary, ADR-0008);
// removal and role change are owner-only, matching invitations.ts (member ≠ admin).

// Single contract for the PATCH body (CLAUDE.md §7): there is exactly one owner, so
// the only valid "role change" is a transfer TO owner — demoting the owner directly
// would leave the workspace ownerless, which the model can't represent.
const ChangeRoleInput = z.object({ role: z.literal('owner') });

// POST body: an existing user id to add as a member (ADR-0014 manual invite — the
// Shell's "Create user…" adds the just-created account to the workspace right away).
const AddMemberInput = z.object({ userId: z.string().min(1) });

/**
 * /api/workspaces/:id/members[/:userId]
 *   GET                            → { members: WorkspaceMemberView[] } (owner first)
 *   POST {userId}                  → 200 { members } owner-only add (idempotent — re-adding is a no-op)
 *   DELETE /:userId                → 204 owner-only (400 removing self — ownership doesn't transfer here)
 *   PATCH /:userId {role:'owner'}  → 200 { members } owner-only ownership transfer
 * A stranger gets 404 (they can't see the workspace at all).
 */
export async function handleMembersApi(
  request: Request,
  database: Database,
  user: GateUser,
  workspaceId: string,
  memberUserId?: string,
): Promise<Response> {
  const ws = await getWorkspace(database, workspaceId, user.id);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });

  if (request.method === 'GET' && !memberUserId) {
    const members = await listWorkspaceMembers(database, ws.id);
    return Response.json({ members });
  }
  if (request.method === 'POST' && !memberUserId) {
    if (ws.ownerUserId !== user.id) return Response.json({ error: 'owner only' }, { status: 403 });
    const parsed = AddMemberInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid body' }, { status: 400 });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: parsed.data.userId, role: 'member' });
    const members = await listWorkspaceMembers(database, ws.id);
    return Response.json({ members });
  }
  if (request.method === 'DELETE' && memberUserId) {
    if (ws.ownerUserId !== user.id) return Response.json({ error: 'owner only' }, { status: 403 });
    if (memberUserId === user.id) return Response.json({ error: 'the owner cannot be removed' }, { status: 400 });
    const removed = await removeWorkspaceMember(database, { workspaceId: ws.id, userId: memberUserId });
    return removed ? new Response(null, { status: 204 }) : Response.json({ error: 'not a member' }, { status: 404 });
  }
  if (request.method === 'PATCH' && memberUserId) {
    if (ws.ownerUserId !== user.id) return Response.json({ error: 'owner only' }, { status: 403 });
    if (memberUserId === user.id) return Response.json({ error: 'already the owner' }, { status: 400 });
    const parsed = ChangeRoleInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid role' }, { status: 400 });
    const transferred = await transferWorkspaceOwnership(database, { workspaceId: ws.id, toUserId: memberUserId });
    if (!transferred) return Response.json({ error: 'not a member' }, { status: 404 });
    const members = await listWorkspaceMembers(database, ws.id);
    return Response.json({ members });
  }
  return new Response('method not allowed', { status: 405 });
}
