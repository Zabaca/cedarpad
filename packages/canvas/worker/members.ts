import type { Database } from '../web-poc/lib/db/index.ts';
import { getWorkspace, listWorkspaceMembers, removeWorkspaceMember } from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';

// Workspace roster (#192, Settings stage). Reading is workspace-visible (owner OR
// member — the roster is not a secret inside the trust boundary, ADR-0008);
// removal is owner-only, matching invitations.ts (member ≠ admin).

/**
 * /api/workspaces/:id/members[/:userId]
 *   GET               → { members: WorkspaceMemberView[] } (owner first)
 *   DELETE /:userId   → 204 owner-only (400 removing self — ownership doesn't transfer here)
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
  if (request.method === 'DELETE' && memberUserId) {
    if (ws.ownerUserId !== user.id) return Response.json({ error: 'owner only' }, { status: 403 });
    if (memberUserId === user.id) return Response.json({ error: 'the owner cannot be removed' }, { status: 400 });
    const removed = await removeWorkspaceMember(database, { workspaceId: ws.id, userId: memberUserId });
    return removed ? new Response(null, { status: 204 }) : Response.json({ error: 'not a member' }, { status: 404 });
  }
  return new Response('method not allowed', { status: 405 });
}
