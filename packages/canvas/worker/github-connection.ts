import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/index.ts';
import {
  clearWorkspaceGithubConnection,
  getWorkspace,
  getWorkspaceRecord,
  setWorkspaceGithubInstallation,
} from '../web-poc/lib/db/queries/workspaces.ts';
import {
  addPatRepo,
  addPublicRepo,
  clearInstallationRepos,
  listWorkspaceRepos,
  removeAddedRepo,
  replaceInstallationRepos,
  updatePatRepoToken,
} from '../web-poc/lib/db/queries/workspace-repos.ts';
import type { GateUser } from './auth-gate.ts';
import { type RepoAuth, buildAppJwt, mintInstallationToken, mintRepoReadToken } from './github-app.ts';
import type { Env } from './index.ts';
import { openSecret, sealSecret } from './secret-box.ts';

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

/** One repo of the workspace's set, with how it authenticates (ADR-0016). The
 *  resolve→mint contract: callers spread this into a mint call and never branch. */
export type WorkspaceRepoView = { repoFullName: string; auth: RepoAuth };

/** The workspace's full Repo set (ADR-0016): its rows (installation-sourced ones need the
 *  App connection to be usable; PAT rows carry their own sealed credential) plus the
 *  transitional env fallback for the default workspace. */
export async function workspaceRepoSet(
  env: Env,
  database: Database,
  ws: { id: string; githubInstallationId: string | null; selectedRepos: string[] | null },
): Promise<WorkspaceRepoView[]> {
  const conn = workspaceGithub(env, ws);
  const rows = await listWorkspaceRepos(database, ws.id);
  const views: WorkspaceRepoView[] = [];
  for (const r of rows) {
    if (r.source === 'pat') {
      if (r.encryptedToken) views.push({ repoFullName: r.fullName, auth: { kind: 'pat', encryptedToken: r.encryptedToken } });
    } else if (r.source === 'public') {
      views.push({ repoFullName: r.fullName, auth: { kind: 'public' } });
    } else if (conn.connected) {
      views.push({ repoFullName: r.fullName, auth: { kind: 'installation', installationId: conn.installationId } });
    }
  }
  if (conn.connected && conn.source === 'env') {
    for (const fullName of conn.selectedRepos) {
      if (!views.some((v) => v.repoFullName === fullName)) {
        views.push({ repoFullName: fullName, auth: { kind: 'installation', installationId: conn.installationId } });
      }
    }
  }
  return views;
}

/** The repo a dev-agent run against `workspaceId` should use, with its auth.
 *  `requested` (the Jobs picker / kick body) must be within the workspace's repo set;
 *  absent ⇒ the first repo. Null ⇒ nothing usable — the run kicks token-less. Resolution
 *  is edge-internal (getWorkspaceRecord): callers key off an already-authorized artifact
 *  (the auth-gated kick route / an owned Conversation). */
export async function resolveDevAgentRepo(
  env: Env,
  database: Database,
  workspaceId: string,
  requested?: string,
): Promise<WorkspaceRepoView | null> {
  const ws = await getWorkspaceRecord(database, workspaceId);
  if (!ws) return null;
  const views = await workspaceRepoSet(env, database, ws);
  if (views.length === 0) return null;
  const view = requested ? views.find((v) => v.repoFullName === requested) : views[0];
  return view ?? null;
}

// ---- PAT repo probe (ADR-0016) ----------------------------------------------

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

type PatRepoProbe = { defaultBranch: string; protected: boolean; canPush: boolean };

/** Live-validate a PAT against its repo: proves reachability and captures the badges
 *  (default branch, protection, push permission). Null ⇒ the token can't see the repo. */
async function probePatRepo(
  fullName: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<PatRepoProbe | null> {
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/repos/${fullName}`, { headers: GH_HEADERS(`token ${token}`) });
  if (!res.ok) return null;
  const json = (await res.json()) as { default_branch: string; permissions?: { push?: boolean } };
  const b = await doFetch(`https://api.github.com/repos/${fullName}/branches/${json.default_branch}`, {
    headers: GH_HEADERS(`token ${token}`),
  });
  const branch = b.ok ? ((await b.json()) as { protected?: boolean }) : {};
  return { defaultBranch: json.default_branch, protected: branch.protected === true, canPush: json.permissions?.push === true };
}

/** Is `fullName` a public GitHub repo? Probes authenticated when the workspace has an App
 *  installation (an unscoped read token can see any public repo; unauthenticated calls from
 *  shared Worker egress IPs are rate-limit roulette), unauthenticated otherwise. Returns the
 *  default branch, or null when the repo is private, missing, or unreachable. */
async function probePublicRepo(
  env: Env,
  ws: { id: string; githubInstallationId: string | null; selectedRepos: string[] | null },
  fullName: string,
  opts: { nowSec: number; fetchImpl?: typeof fetch },
): Promise<{ defaultBranch: string } | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const conn = workspaceGithub(env, ws);
  let auth: string | null = null;
  if (conn.connected && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    try {
      const { token } = await mintInstallationToken(
        { appId: env.GITHUB_APP_ID, installationId: conn.installationId, privateKey: env.GITHUB_APP_PRIVATE_KEY },
        { permissions: { contents: 'read' }, nowSec: opts.nowSec, fetchImpl: opts.fetchImpl },
      );
      auth = `token ${token}`;
    } catch {
      auth = null; // fall back to unauthenticated
    }
  }
  const res = await doFetch(`https://api.github.com/repos/${fullName}`, {
    headers: auth ? GH_HEADERS(auth) : { Accept: 'application/vnd.github+json', 'User-Agent': 'cedarpad-dev-agent' },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { private?: boolean; default_branch?: string };
  if (json.private !== false) return null;
  return { defaultBranch: json.default_branch ?? 'main' };
}

// ---- API handlers -----------------------------------------------------------

const SelectInput = z.object({ selected: z.array(z.string().regex(REPO_NAME)).max(50) });
const ExternalAddInput = z.object({ fullName: z.string().regex(REPO_NAME), token: z.string().min(1).max(400) });
const ExternalRemoveInput = z.object({ fullName: z.string().regex(REPO_NAME) });
const PublicAddInput = z.object({ fullName: z.string().regex(REPO_NAME) });

/**
 * /api/workspaces/:id/github[…] — the Settings repository section.
 *   GET             → status: connection + selection + granted repos (live) + PAT repos (live badges)
 *   GET  /connect   → 302 to GitHub's install page with signed state (owner-only)
 *   PUT  /repos     → replace the installation selection, ⊆ granted (owner-only)
 *   POST /external  → add a PAT repo: live-validate, seal, store (owner-only, ADR-0016)
 *   PATCH /external → rotate a PAT repo's token: live-validate, re-seal (owner-only)
 *   DELETE /external→ remove a user-added repo, PAT or public (owner-only)
 *   POST /public    → add a public repo by name — the canvas GithubRepoCard's Clone
 *                     (owner-only; validates the repo is really public; no credential)
 *   DELETE          → disconnect the App installation (PAT repos survive; owner-only)
 */
export async function handleGithubApi(
  request: Request,
  env: Env,
  database: Database,
  user: GateUser,
  workspaceId: string,
  sub: 'connect' | 'repos' | 'external' | 'refresh' | 'public' | undefined,
  deps: {
    nowMs: number;
    fetchImpl?: typeof fetch;
    /** Push one repo's read-only checkout refresh to the workspace's container (ADR-0016).
     *  The token rides a header, transient — the bridge scrubs it after the fetch.
     *  Public repos push token-less (the checkout clones the public HTTPS remote). */
    pushRefresh?: (repoFullName: string, token?: string) => Promise<Response>;
  },
): Promise<Response> {
  const ws = await getWorkspace(database, workspaceId, user.id);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });
  const isOwner = ws.ownerUserId === user.id;
  const nowSec = Math.floor(deps.nowMs / 1000);

  // Checkout refresh (ADR-0016): member-allowed — it grants nothing (reads land in the
  // container the member already uses); it just makes the Repo assets fresh.
  if (sub === 'refresh') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = (await request.json().catch(() => ({}))) as { fullName?: string };
    const views = await workspaceRepoSet(env, database, ws);
    const targets = body.fullName ? views.filter((v) => v.repoFullName === body.fullName) : views;
    if (body.fullName && targets.length === 0) return Response.json({ error: 'repo not in this workspace' }, { status: 404 });
    const refreshed: string[] = [];
    const failed: string[] = [];
    for (const v of targets) {
      const token = await mintRepoReadToken(env, { nowSec, ...v, fetchImpl: deps.fetchImpl }).catch(() => null);
      // Public repos have no token by nature — the checkout pulls the public remote.
      const usable = v.auth.kind === 'public' || token !== null;
      const res =
        usable && deps.pushRefresh ? await deps.pushRefresh(v.repoFullName, token ?? undefined).catch(() => null) : null;
      (res?.ok ? refreshed : failed).push(v.repoFullName);
    }
    return Response.json({ refreshed, failed });
  }

  // Public repo add (ADR-0016 addendum): the canvas GithubRepoCard's Clone button. A member
  // clicking it gets this 403 — the card turns that into a visible "requested by" stamp.
  if (sub === 'public') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });
    const parsed = PublicAddInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid repo' }, { status: 400 });
    const { fullName } = parsed.data;
    const existing = await listWorkspaceRepos(database, ws.id);
    if (existing.some((r) => r.fullName === fullName)) {
      return Response.json({ error: `${fullName} is already in this workspace` }, { status: 409 });
    }
    const probe = await probePublicRepo(env, ws, fullName, { nowSec, fetchImpl: deps.fetchImpl }).catch(() => null);
    if (!probe) {
      return Response.json({ error: `${fullName} is not a public repo (private, missing, or unreachable)` }, { status: 400 });
    }
    await addPublicRepo(database, { workspaceId: ws.id, fullName, addedByUserId: user.id });
    // Seed the read-only checkout right away (token-less), so "clone → ask about it" works
    // without waiting for a cadence tick. Best-effort.
    if (deps.pushRefresh) {
      void deps.pushRefresh(fullName).catch((e: unknown) => {
        console.error(`[repos] post-add checkout refresh failed for ${fullName}: ${String(e)}`);
      });
    }
    return Response.json({ fullName, defaultBranch: probe.defaultBranch, source: 'public' });
  }

  if (sub === 'external') {
    if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });
    const key = env.REPO_TOKEN_KEY;
    if (!key) return Response.json({ error: 'PAT repos not configured (REPO_TOKEN_KEY unset)' }, { status: 503 });

    if (request.method === 'POST' || request.method === 'PATCH') {
      const parsed = ExternalAddInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'invalid repo or token' }, { status: 400 });
      const { fullName, token } = parsed.data;
      const probe = await probePatRepo(fullName, token, deps.fetchImpl);
      if (!probe) return Response.json({ error: `the token cannot reach ${fullName}` }, { status: 400 });
      const encryptedToken = await sealSecret(key, token);
      if (request.method === 'POST') {
        const existing = await listWorkspaceRepos(database, ws.id);
        if (existing.some((r) => r.fullName === fullName)) {
          return Response.json({ error: `${fullName} is already in this workspace` }, { status: 409 });
        }
        await addPatRepo(database, { workspaceId: ws.id, fullName, encryptedToken, addedByUserId: user.id });
      } else {
        await updatePatRepoToken(database, { workspaceId: ws.id, fullName, encryptedToken });
      }
      // Seed/refresh the read-only checkout right away with the just-validated token, so
      // "add repo → ask about it" works without waiting for a cadence tick. Best-effort.
      if (deps.pushRefresh) {
        void deps.pushRefresh(fullName, token).catch((e: unknown) => {
          console.error(`[repos] post-add checkout refresh failed for ${fullName}: ${String(e)}`);
        });
      }
      return Response.json({ fullName, ...probe });
    }

    if (request.method === 'DELETE') {
      const parsed = ExternalRemoveInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'invalid repo' }, { status: 400 });
      await removeAddedRepo(database, { workspaceId: ws.id, fullName: parsed.data.fullName });
      return new Response(null, { status: 204 });
    }

    return new Response('method not allowed', { status: 405 });
  }

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
    const rows = await listWorkspaceRepos(database, ws.id);
    // PAT repos report live badges (reachability doubles as token health, ADR-0016).
    const key = env.REPO_TOKEN_KEY;
    const patRepos = await Promise.all(
      rows
        .filter((r) => r.source === 'pat')
        .map(async (r) => {
          const token = key && r.encryptedToken ? await openSecret(key, r.encryptedToken) : null;
          const probe = token ? await probePatRepo(r.fullName, token, deps.fetchImpl) : null;
          return probe
            ? { fullName: r.fullName, ...probe }
            : { fullName: r.fullName, defaultBranch: null, protected: false, canPush: false, unreachable: true };
        }),
    );
    const publicRepos = rows.filter((r) => r.source === 'public').map((r) => ({ fullName: r.fullName }));
    if (!conn.connected) {
      return Response.json({ connected: false, selectedRepos: [], patRepos, publicRepos, canConnect: isOwner && !!env.GITHUB_APP_SLUG });
    }
    let grantedRepos: GrantedRepo[] | undefined;
    try {
      grantedRepos = await listGrantedRepos(env, conn.installationId, { nowSec, fetchImpl: deps.fetchImpl });
    } catch (e: unknown) {
      console.error(`[github] granted-repo list failed for ws ${ws.id}: ${String(e)}`);
    }
    const selectedRepos =
      conn.source === 'env' ? conn.selectedRepos : rows.filter((r) => r.source === 'installation').map((r) => r.fullName);
    return Response.json({
      connected: true,
      source: conn.source,
      selectedRepos,
      grantedRepos,
      patRepos,
      publicRepos,
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
    await replaceInstallationRepos(database, { workspaceId: ws.id, repos: parsed.data.selected });
    return Response.json({ selectedRepos: parsed.data.selected });
  }

  if (request.method === 'DELETE' && !sub) {
    if (!isOwner) return Response.json({ error: 'owner only' }, { status: 403 });
    // Disconnecting the App clears its rows; PAT repos are separate connections and survive.
    await clearInstallationRepos(database, ws.id);
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
