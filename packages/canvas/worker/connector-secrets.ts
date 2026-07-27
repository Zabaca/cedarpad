import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/index.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import {
  deleteWorkspaceConnector,
  listWorkspaceConnectors,
  setWorkspaceConnector,
} from '../web-poc/lib/db/queries/workspace-connectors.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { openSecret, sealSecret } from './secret-box.ts';

// Connector secrets (#241): per-workspace, encrypted third-party connector credentials
// (dlt sources for the warehouse pipeline, ADR-0017 — Slack/Stripe/Mercury tokens, none
// shipped by this issue). Reuses the exact PAT pattern from github-connection.ts: sealed
// with the platform key via secret-box.ts, owner-gated mutation, member-visible list. The
// key difference from a repo PAT: there is nothing to live-validate a third-party token
// against generically, so set/delete trust the caller and never probe.
//
// Key choice: this reuses env.REPO_TOKEN_KEY, the same platform secret that already seals
// workspace_repos.encrypted_token. Both are "at-rest, per-workspace, third-party bearer
// credential" — the same trust boundary — so a second SOPS-provisioned key would be an
// unrequested new secret, not a safety improvement. Named generically (not "repo") because
// the secret-box format has no notion of what it's sealing.

const SetInput = z.object({ connectorName: z.string().min(1).max(100), secret: z.string().min(1).max(4000) });
const DeleteInput = z.object({ connectorName: z.string().min(1).max(100) });

/**
 * /api/workspaces/:id/connectors — owner-gated connector credential management.
 *   GET    → list: connector name + createdAt only. NEVER plaintext or ciphertext.
 *   POST   → set (insert or rotate) a connector's secret (owner-only)
 *   DELETE → remove a connector's credential (owner-only)
 */
export async function handleConnectorSecretsApi(
  request: Request,
  env: Env,
  database: Database,
  user: GateUser,
  workspaceId: string,
): Promise<Response> {
  const ws = await getWorkspace(database, workspaceId, user.id);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });
  const isOwner = ws.ownerUserId === user.id;

  if (request.method === 'GET') {
    const rows = await listWorkspaceConnectors(database, ws.id);
    return Response.json({
      connectors: rows.map((r) => ({ connectorName: r.connectorName, createdAt: r.createdAt })),
    });
  }

  if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });

  if (request.method === 'POST') {
    const key = env.REPO_TOKEN_KEY;
    if (!key) return Response.json({ error: 'connector secrets not configured (REPO_TOKEN_KEY unset)' }, { status: 503 });
    const parsed = SetInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid connector name or secret' }, { status: 400 });
    const encryptedSecret = await sealSecret(key, parsed.data.secret);
    await setWorkspaceConnector(database, {
      workspaceId: ws.id,
      connectorName: parsed.data.connectorName,
      encryptedSecret,
      addedByUserId: user.id,
    });
    return Response.json({ connectorName: parsed.data.connectorName });
  }

  if (request.method === 'DELETE') {
    const parsed = DeleteInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid connector name' }, { status: 400 });
    await deleteWorkspaceConnector(database, { workspaceId: ws.id, connectorName: parsed.data.connectorName });
    return new Response(null, { status: 204 });
  }

  return new Response('method not allowed', { status: 405 });
}

/** Decrypt every connector secret a workspace holds, keyed by connector name — the env
 *  the warehouse container's dlt sources read from (worker/container-env.ts). Unopenable
 *  seals (wrong/rotated key, tamper) are dropped rather than thrown — same "treat like
 *  missing" policy as openSecret's own contract. Edge-internal only: callers must already
 *  know which workspace's warehouse run this is for. */
export async function resolveConnectorEnv(env: Env, database: Database, workspaceId: string): Promise<Record<string, string>> {
  const key = env.REPO_TOKEN_KEY;
  if (!key) return {};
  const rows = await listWorkspaceConnectors(database, workspaceId);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const secret = await openSecret(key, row.encryptedSecret);
    if (secret !== null) out[row.connectorName] = secret;
  }
  return out;
}
