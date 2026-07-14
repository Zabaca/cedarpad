import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/index.ts';
import {
  clearWorkspaceGithubConnection,
  getWorkspace,
  setWorkspaceGithubInstallation,
  setWorkspaceSelectedRepos,
} from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';
import { buildAppJwt, mintInstallationToken } from './github-app.ts';
import type { Env } from './index.ts';

// Repository connection (#193, ADR-0015). The GitHub App identity stays platform env;
// the INSTALLATION and the SELECTED repos are workspace config. The owner connects via
// GitHub's install flow with a signed `state` binding the redirect back to the workspace
// (CSRF-safe: the callback trusts the signature, never the session's "current" workspace).
// Reads are workspace-visible; every mutation is owner-only — connecting a repo is a
// capability grant to the whole workspace (its agents get push/PR reach into that repo).

/** The env-fallback repo while the default workspace has no connection row (grill Q5).
 *  Deleted together with GITHUB_APP_INSTALLATION_ID once James connects via the UI. */
const ENV_FALLBACK_REPO = 'Zabaca/cedarpad';
const ENV_FALLBACK_WORKSPACE = 'default';

const STATE_TTL_MS = 15 * 60_000;

// ---- Signed connect state ---------------------------------------------------

const StatePayload = z.object({ ws: z.string().min(1), exp: z.number() });

const hmac = (secret: string, payload: string): Buffer =>
  createHmac('sha256', secret).update(payload).digest();

/** `<b64url payload>.<b64url hmac>` binding a workspace id until `expMs`. */
export function signState(secret: string, workspaceId: string, expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ ws: workspaceId, exp: expMs })).toString('base64url');
  return `${payload}.${hmac(secret, payload).toString('base64url')}`;
}

/** The workspace id a state names, or null (bad signature, malformed, expired). */
export function verifyState(secret: string, state: string, nowMs: number): string | null {
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const payload = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1), 'base64url');
  const expected = hmac(secret, payload);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  const parsed = StatePayload.safeParse(
    JSON.parse(Buffer.from(payload, 'base64url').toString('utf8') || 'null'),
  );
  if (!parsed.success || parsed.data.exp <= nowMs) return null;
  return parsed.data.ws;
}

// ---- GitHub reads (granted repos + protection) ------------------------------

const GH_HEADERS = (auth: string) => ({
  Authorization: auth,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cedarpad-dev-agent',
});

type GrantedRepo = { fullName: string; defaultBranch: string; protected: boolean };

/** The repos an installation granted, each with its default branch and whether that
 *  branch is protected — the "merge is the arming step" badge (ADR-0015's caveat). */
async function listGrantedRepos(
  env: Env,
  installationId: string,
  opts: { nowSec: number; fetchImpl?: typeof fetch },
): Promise<GrantedRepo[]> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return [];
  const doFetch = opts.fetchImpl ?? fetch;
  // Read-scoped token covering the whole grant (no `repositories` filter — we're listing it).
  const { token } = await mintInstallationToken(
    { appId, installationId, privateKey },
    { permissions: { contents: 'read' }, nowSec: opts.nowSec, fetchImpl: opts.fetchImpl },
  );
  const res = await doFetch('https://api.github.com/installation/repositories', {
    headers: GH_HEADERS(`token ${token}`),
  });
  if (!res.ok) throw new Error(`installation/repositories: ${res.status}`);
  const json = (await res.json()) as { repositories: { full_name: string; default_branch: string }[] };
  return Promise.all(
    json.repositories.map(async (r) => {
      const b = await doFetch(`https://api.github.com/repos/${r.full_name}/branches/${r.default_branch}`, {
        headers: GH_HEADERS(`token ${token}`),
      });
      const branch = b.ok ? ((await b.json()) as { protected?: boolean }) : {};
      return { fullName: r.full_name, defaultBranch: r.default_branch, protected: branch.protected === true };
    }),
  );
}

// ---- The workspace's effective connection -----------------------------------

export type WorkspaceGithub =
  | { connected: false }
  | { connected: true; source: 'workspace' | 'env'; installationId: string; selectedRepos: string[] };

/** The connection the rest of the platform should use for a workspace: its row, or the
 *  transitional env fallback for the default workspace. */
export function workspaceGithub(
  env: Env,
  ws: { id: string; githubInstallationId: string | null; selectedRepos: string[] | null },
): WorkspaceGithub {
  if (ws.githubInstallationId) {
    return { connected: true, source: 'workspace', installationId: ws.githubInstallationId, selectedRepos: ws.selectedRepos ?? [] };
  }
  if (ws.id === ENV_FALLBACK_WORKSPACE && env.GITHUB_APP_INSTALLATION_ID) {
    return { connected: true, source: 'env', installationId: env.GITHUB_APP_INSTALLATION_ID, selectedRepos: [ENV_FALLBACK_REPO] };
  }
  return { connected: false };
}

// ---- API handlers -----------------------------------------------------------

const SelectInput = z.object({ selected: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(50) });

/**
 * /api/workspaces/:id/github[…] — the Settings repository section.
 *   GET            → status: connection + selection + granted repos (fetched live)
 *   GET  /connect  → 302 to GitHub's install page with signed state (owner-only)
 *   PUT  /repos    → replace the selection, ⊆ granted (owner-only)
 *   DELETE         → disconnect (owner-only)
 */
export async function handleGithubApi(
  request: Request,
  env: Env,
  database: Database,
  user: GateUser,
  workspaceId: string,
  sub: 'connect' | 'repos' | undefined,
  deps: { nowMs: number; fetchImpl?: typeof fetch },
): Promise<Response> {
  const ws = await getWorkspace(database, workspaceId, user.id);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });
  const isOwner = ws.ownerUserId === user.id;
  const nowSec = Math.floor(deps.nowMs / 1000);

  if (request.method === 'GET' && sub === 'connect') {
    if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });
    const slug = env.GITHUB_APP_SLUG;
    const secret = env.BETTER_AUTH_SECRET;
    if (!slug || !secret) return Response.json({ error: 'GitHub App not configured' }, { status: 503 });
    const state = signState(secret, ws.id, deps.nowMs + STATE_TTL_MS);
    const url = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
    return new Response(null, { status: 302, headers: { location: url } });
  }

  if (request.method === 'GET' && !sub) {
    const conn = workspaceGithub(env, ws);
    if (!conn.connected) {
      return Response.json({ connected: false, selectedRepos: [], canConnect: isOwner && !!env.GITHUB_APP_SLUG });
    }
    let grantedRepos: GrantedRepo[] | undefined;
    try {
      grantedRepos = await listGrantedRepos(env, conn.installationId, { nowSec, fetchImpl: deps.fetchImpl });
    } catch (e: unknown) {
      console.error(`[github] granted-repo list failed for ws ${ws.id}: ${String(e)}`);
    }
    return Response.json({
      connected: true,
      source: conn.source,
      selectedRepos: conn.selectedRepos,
      grantedRepos,
      canConnect: isOwner && !!env.GITHUB_APP_SLUG,
    });
  }

  if (request.method === 'PUT' && sub === 'repos') {
    if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });
    const conn = workspaceGithub(env, ws);
    if (!conn.connected || conn.source !== 'workspace') {
      return Response.json({ error: 'not connected' }, { status: 409 });
    }
    const parsed = SelectInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid selection' }, { status: 400 });
    const granted = await listGrantedRepos(env, conn.installationId, { nowSec, fetchImpl: deps.fetchImpl });
    const grantedNames = new Set(granted.map((r) => r.fullName));
    const outside = parsed.data.selected.filter((r) => !grantedNames.has(r));
    if (outside.length > 0) {
      return Response.json({ error: `not granted to the installation: ${outside.join(', ')}` }, { status: 400 });
    }
    await setWorkspaceSelectedRepos(database, { workspaceId: ws.id, repos: parsed.data.selected });
    return Response.json({ selectedRepos: parsed.data.selected });
  }

  if (request.method === 'DELETE' && !sub) {
    if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });
    await clearWorkspaceGithubConnection(database, ws.id);
    return new Response(null, { status: 204 });
  }

  return new Response('method not allowed', { status: 405 });
}

/**
 * GET /api/github/setup?installation_id&state — GitHub's post-install redirect (the App's
 * Setup URL). Verifies the signed state (which workspace initiated), owner-checks the
 * session against it, verifies the installation actually belongs to OUR App, persists,
 * and lands back on the Settings stage.
 */
export async function handleGithubSetup(
  request: Request,
  env: Env,
  database: Database,
  user: GateUser,
  deps: { nowMs: number; fetchImpl?: typeof fetch },
): Promise<Response> {
  const url = new URL(request.url);
  const installationId = url.searchParams.get('installation_id');
  const state = url.searchParams.get('state');
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || !installationId || !/^\d+$/.test(installationId) || !state) {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
  const workspaceId = verifyState(secret, state, deps.nowMs);
  if (!workspaceId) return Response.json({ error: 'invalid or expired state' }, { status: 400 });

  const ws = await getWorkspace(database, workspaceId, user.id);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });
  if (ws.ownerUserId !== user.id) return Response.json({ error: 'owner only' }, { status: 403 });

  // The installation must belong to OUR App — a pasted/foreign installation id must not
  // connect (and could never mint anyway; failing here is just the honest error).
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return Response.json({ error: 'GitHub App not configured' }, { status: 503 });
  const doFetch = deps.fetchImpl ?? fetch;
  const jwt = buildAppJwt({ appId, installationId, privateKey }, Math.floor(deps.nowMs / 1000));
  const res = await doFetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: GH_HEADERS(`Bearer ${jwt}`),
  });
  const info = res.ok ? ((await res.json()) as { app_id?: number }) : null;
  if (!info || String(info.app_id) !== appId) {
    return Response.json({ error: 'installation does not belong to this App' }, { status: 400 });
  }

  await setWorkspaceGithubInstallation(database, { workspaceId: ws.id, installationId });
  return new Response(null, { status: 302, headers: { location: '/?stage=settings' } });
}
