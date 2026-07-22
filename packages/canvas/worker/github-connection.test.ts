import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { createWorkspace, getWorkspace, addWorkspaceMember } from '../web-poc/lib/db/queries/workspaces.ts';
import { listWorkspaceRepos } from '../web-poc/lib/db/queries/workspace-repos.ts';
import { handleGithubApi, handleGithubSetup, resolveDevAgentRepo, signState, verifyState } from './github-connection.ts';
import type { Env } from './index.ts';

// In-memory DB from the real migrations (mirrors members.test.ts).
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}

const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

const OWNER = { id: 'owner_g1', email: 'owner_g1@example.com' };
const MEMBER = { id: 'member_g1', email: 'member_g1@example.com' };

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const u of [OWNER, MEMBER]) {
    await db.insert(schema.user).values({ id: u.id, name: u.id, email: u.email });
  }
});

const SECRET = 'test-signing-secret';
const NOW = 1_752_000_000_000;

describe('signed connect state (#193) — CSRF-safe workspace binding', () => {
  test('round-trips the workspace id within its lifetime', () => {
    const state = signState(SECRET, 'ws_x', NOW + 15 * 60_000);
    expect(verifyState(SECRET, state, NOW)).toBe('ws_x');
  });

  test('a tampered payload or wrong secret is rejected', () => {
    const state = signState(SECRET, 'ws_x', NOW + 15 * 60_000);
    const [payload, sig] = state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ws: 'ws_other', exp: NOW + 15 * 60_000 })).toString('base64url')}.${sig}`;
    expect(verifyState(SECRET, forged, NOW)).toBeNull();
    expect(verifyState('other-secret', state, NOW)).toBeNull();
    expect(verifyState(SECRET, `${payload}.`, NOW)).toBeNull();
    expect(verifyState(SECRET, 'garbage', NOW)).toBeNull();
  });

  test('an expired state is rejected', () => {
    const state = signState(SECRET, 'ws_x', NOW - 1);
    expect(verifyState(SECRET, state, NOW)).toBeNull();
  });
});

// ---- API handler, with a stubbed GitHub ------------------------------------

const APP_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_INSTALLATION_ID: '777',
  GITHUB_APP_PRIVATE_KEY: TEST_KEY(),
  GITHUB_APP_SLUG: 'cedarpad-dev',
  BETTER_AUTH_SECRET: SECRET,
} as unknown as Env;

// A throwaway RSA key so buildAppJwt can sign (the stub never validates it).
function TEST_KEY(): string {
  const { generateKeyPairSync } = require('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

/** GitHub API stub: installation lookup, token mint, granted-repo list, branch protection. */
function githubStub(opts?: { installationApp?: string }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (/\/app\/installations\/\d+$/.test(url)) {
      return Response.json({ id: 999, app_id: Number(opts?.installationApp ?? '12345'), account: { login: 'Zabaca' } });
    }
    if (url.includes('/access_tokens')) return Response.json({ token: 'ghs_stub', expires_at: 'later' });
    if (url.endsWith('/installation/repositories')) {
      return Response.json({
        repositories: [
          { full_name: 'Zabaca/cedarpad', default_branch: 'main' },
          { full_name: 'Zabaca/ledgerbot', default_branch: 'master' },
        ],
      });
    }
    const branch = /\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/.exec(url);
    if (branch) return Response.json({ name: branch[2], protected: branch[1] === 'Zabaca/cedarpad' });
    return new Response('stub 404', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://poc.cedarpad.com${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe('handleGithubApi — status/connect/repos/disconnect (#193)', () => {
  test('a connected workspace reports its granted repos (live) + selection + protection badge', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStub();
    // connect directly through the setup callback path below; here seed the row:
    const okSetup = await handleGithubSetup(
      req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW + 60_000)}`),
      APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl },
    );
    expect(okSetup.status).toBe(302);
    expect(okSetup.headers.get('location')).toBe('/?stage=settings');

    const res = await handleGithubApi(req('GET', '/x'), APP_ENV, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.connected).toBe(true);
    expect(body.source).toBe('workspace');
    expect(body.grantedRepos).toEqual([
      { fullName: 'Zabaca/cedarpad', defaultBranch: 'main', protected: true },
      { fullName: 'Zabaca/ledgerbot', defaultBranch: 'master', protected: false },
    ]);
    expect(body.selectedRepos).toEqual([]);
  });

  test('the owner selects repos from the grant; a non-granted repo is a 400; members are 403', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws-2', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });
    const { fetchImpl } = githubStub();
    await handleGithubSetup(
      req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW + 60_000)}`),
      APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl },
    );

    const ok = await handleGithubApi(req('PUT', '/x', { selected: ['Zabaca/ledgerbot'] }), APP_ENV, database, OWNER, ws.id, 'repos', { nowMs: NOW, fetchImpl });
    expect(ok.status).toBe(200);
    const after = await readJson(await handleGithubApi(req('GET', '/x'), APP_ENV, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl }));
    expect(after.selectedRepos).toEqual(['Zabaca/ledgerbot']);

    const bad = await handleGithubApi(req('PUT', '/x', { selected: ['Evil/other'] }), APP_ENV, database, OWNER, ws.id, 'repos', { nowMs: NOW, fetchImpl });
    expect(bad.status).toBe(400);
    const asMember = await handleGithubApi(req('PUT', '/x', { selected: [] }), APP_ENV, database, MEMBER, ws.id, 'repos', { nowMs: NOW, fetchImpl });
    expect(asMember.status).toBe(403);
  });

  test('connect 302s to the GitHub install URL carrying a verifiable state (owner-only)', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws-3', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });
    const { fetchImpl } = githubStub();
    const res = await handleGithubApi(req('GET', '/x'), APP_ENV, database, OWNER, ws.id, 'connect', { nowMs: NOW, fetchImpl });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.href.startsWith('https://github.com/apps/cedarpad-dev/installations/new')).toBe(true);
    expect(verifyState(SECRET, loc.searchParams.get('state') ?? '', NOW)).toBe(ws.id);

    const asMember = await handleGithubApi(req('GET', '/x'), APP_ENV, database, MEMBER, ws.id, 'connect', { nowMs: NOW, fetchImpl });
    expect(asMember.status).toBe(403);
  });

  test('an unconnected workspace with no env fallback is simply not connected', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws-4', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStub();
    const noApp = { BETTER_AUTH_SECRET: SECRET } as unknown as Env;
    const body = await readJson(await handleGithubApi(req('GET', '/x'), noApp, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl }));
    expect(body.connected).toBe(false);
    expect(body.selectedRepos).toEqual([]);
  });

  test('the default workspace transitionally falls back to the env installation + Zabaca/cedarpad', async () => {
    // the `default` workspace: create it with the literal id via direct insert
    await db.insert(schema.workspaces).values({ id: 'default', name: 'Default', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStub();
    const body = await readJson(await handleGithubApi(req('GET', '/x'), APP_ENV, database, OWNER, 'default', undefined, { nowMs: NOW, fetchImpl }));
    expect(body.connected).toBe(true);
    expect(body.source).toBe('env');
    expect(body.selectedRepos).toEqual(['Zabaca/cedarpad']);
  });

  test('disconnect clears the connection and the selection (owner-only)', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws-5', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStub();
    await handleGithubSetup(
      req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW + 60_000)}`),
      APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl },
    );
    const res = await handleGithubApi(req('DELETE', '/x'), APP_ENV, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl });
    expect(res.status).toBe(204);
    const body = await readJson(await handleGithubApi(req('GET', '/x'), APP_ENV, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl }));
    expect(body.connected).toBe(false);
  });
});

// ---- ADR-0016: PAT repos + the unified repo set ----------------------------

/** Extends githubStub with a PAT-authed repo probe for `hudsonts/app`. */
function githubStubWithPat(opts?: { patOk?: boolean; push?: boolean }) {
  const base = githubStub();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    if (/\/repos\/hudsonts\/app$/.test(url)) {
      if (opts?.patOk === false || !auth.includes('github_pat_hudson')) return new Response('bad creds', { status: 401 });
      return Response.json({ full_name: 'hudsonts/app', default_branch: 'main', permissions: { push: opts?.push !== false } });
    }
    if (/\/repos\/hudsonts\/app\/branches\/main$/.test(url)) return Response.json({ name: 'main', protected: false });
    return base.fetchImpl(input as never, init);
  }) as typeof fetch;
  return { fetchImpl };
}

const PAT_ENV = { ...(APP_ENV as unknown as Record<string, unknown>), REPO_TOKEN_KEY: 'test-platform-key' } as unknown as Env;

async function connectedWorkspace(name: string, fetchImpl: typeof fetch) {
  const ws = await createWorkspace(database, { name, ownerUserId: OWNER.id });
  await handleGithubSetup(
    req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW + 60_000)}`),
    APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl },
  );
  return ws;
}

describe('handleGithubApi — PAT repos (ADR-0016)', () => {
  test('the owner adds a PAT repo: validated live, sealed at rest, listed with badges', async () => {
    const { fetchImpl } = githubStubWithPat();
    const ws = await connectedWorkspace('pat-ws-1', fetchImpl);

    const add = await handleGithubApi(
      req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }),
      PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(add.status).toBe(200);
    expect(await readJson(add)).toMatchObject({ fullName: 'hudsonts/app', canPush: true });

    // Sealed at rest: the stored row never contains the plaintext PAT.
    const rows = await listWorkspaceRepos(database, ws.id);
    const pat = rows.find((r) => r.source === 'pat');
    expect(pat?.fullName).toBe('hudsonts/app');
    expect(pat?.encryptedToken ?? '').not.toContain('github_pat_hudson');

    const status = await readJson(await handleGithubApi(req('GET', '/x'), PAT_ENV, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl }));
    expect(status.patRepos).toEqual([{ fullName: 'hudsonts/app', defaultBranch: 'main', protected: false, canPush: true }]);
  });

  test('an invalid token is rejected live (nothing stored); members are 403; dup is 409', async () => {
    const { fetchImpl } = githubStubWithPat();
    const ws = await connectedWorkspace('pat-ws-2', fetchImpl);
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    const bad = await handleGithubApi(
      req('POST', '/x', { fullName: 'hudsonts/app', token: 'wrong' }),
      PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(bad.status).toBe(400);
    expect(await listWorkspaceRepos(database, ws.id)).toEqual([]);

    const asMember = await handleGithubApi(
      req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }),
      PAT_ENV, database, MEMBER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(asMember.status).toBe(403);

    const ok = await handleGithubApi(
      req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }),
      PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(ok.status).toBe(200);
    const dup = await handleGithubApi(
      req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }),
      PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(dup.status).toBe(409);
  });

  test('rotate re-validates and replaces the seal; remove deletes the row (owner-only)', async () => {
    const { fetchImpl } = githubStubWithPat();
    const ws = await connectedWorkspace('pat-ws-3', fetchImpl);
    await handleGithubApi(req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }), PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl });
    const before = (await listWorkspaceRepos(database, ws.id))[0]?.encryptedToken;

    const rot = await handleGithubApi(
      req('PATCH', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }),
      PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(rot.status).toBe(200);
    const after = (await listWorkspaceRepos(database, ws.id))[0]?.encryptedToken;
    expect(after).toBeDefined();
    expect(after).not.toBe(before); // fresh IV ⇒ new seal

    const del = await handleGithubApi(
      req('DELETE', '/x', { fullName: 'hudsonts/app' }),
      PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl },
    );
    expect(del.status).toBe(204);
    expect(await listWorkspaceRepos(database, ws.id)).toEqual([]);
  });
});

// ---- Public repos (ADR-0016 addendum): pasted GitHub URL → canvas Clone ----

/** Extends githubStubWithPat with public-repo probes: vercel/next.js is public,
 *  acme/secret is invisible (private repos 404 to outsiders), acme/internal says private. */
function githubStubWithPublic() {
  const base = githubStubWithPat();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/repos\/vercel\/next\.js$/.test(url)) return Response.json({ full_name: 'vercel/next.js', private: false, default_branch: 'canary' });
    if (/\/repos\/acme\/secret$/.test(url)) return new Response('not found', { status: 404 });
    if (/\/repos\/acme\/internal$/.test(url)) return Response.json({ full_name: 'acme/internal', private: true, default_branch: 'main' });
    return base.fetchImpl(input as never, init);
  }) as typeof fetch;
  return { fetchImpl };
}

describe('handleGithubApi — public repos (canvas GithubRepoCard Clone)', () => {
  test('the owner clones a public repo: validated public, stored token-less, listed, checkout seeded without a token', async () => {
    const { fetchImpl } = githubStubWithPublic();
    const ws = await connectedWorkspace('pub-ws-1', fetchImpl);
    const pushed: Array<{ repo: string; token: string | undefined }> = [];

    const add = await handleGithubApi(req('POST', '/x', { fullName: 'vercel/next.js' }), PAT_ENV, database, OWNER, ws.id, 'public', {
      nowMs: NOW,
      fetchImpl,
      pushRefresh: async (repo, token) => {
        pushed.push({ repo, token });
        return new Response(null, { status: 200 });
      },
    });
    expect(add.status).toBe(200);
    expect(await readJson(add)).toEqual({ fullName: 'vercel/next.js', defaultBranch: 'canary', source: 'public' });

    const row = (await listWorkspaceRepos(database, ws.id)).find((r) => r.fullName === 'vercel/next.js');
    expect(row?.source).toBe('public');
    expect(row?.encryptedToken).toBeNull();

    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget seed settles
    expect(pushed).toEqual([{ repo: 'vercel/next.js', token: undefined }]);

    const status = await readJson(await handleGithubApi(req('GET', '/x'), PAT_ENV, database, OWNER, ws.id, undefined, { nowMs: NOW, fetchImpl }));
    expect(status.publicRepos).toEqual([{ fullName: 'vercel/next.js' }]);
  });

  test('a private or missing repo is a 400 (nothing stored); members are 403; dup is 409', async () => {
    const { fetchImpl } = githubStubWithPublic();
    const ws = await connectedWorkspace('pub-ws-2', fetchImpl);
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });

    for (const name of ['acme/secret', 'acme/internal']) {
      const bad = await handleGithubApi(req('POST', '/x', { fullName: name }), PAT_ENV, database, OWNER, ws.id, 'public', { nowMs: NOW, fetchImpl });
      expect(bad.status).toBe(400);
    }
    expect(await listWorkspaceRepos(database, ws.id)).toEqual([]);

    const asMember = await handleGithubApi(req('POST', '/x', { fullName: 'vercel/next.js' }), PAT_ENV, database, MEMBER, ws.id, 'public', { nowMs: NOW, fetchImpl });
    expect(asMember.status).toBe(403);

    const ok = await handleGithubApi(req('POST', '/x', { fullName: 'vercel/next.js' }), PAT_ENV, database, OWNER, ws.id, 'public', { nowMs: NOW, fetchImpl });
    expect(ok.status).toBe(200);
    const dup = await handleGithubApi(req('POST', '/x', { fullName: 'vercel/next.js' }), PAT_ENV, database, OWNER, ws.id, 'public', { nowMs: NOW, fetchImpl });
    expect(dup.status).toBe(409);
  });

  test('a public repo works with NO App and NO token key (unauthenticated probe), and DELETE /external removes it', async () => {
    const ws = await createWorkspace(database, { name: 'pub-ws-3', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStubWithPublic();
    const bareEnv = { BETTER_AUTH_SECRET: SECRET } as unknown as Env;

    const add = await handleGithubApi(req('POST', '/x', { fullName: 'vercel/next.js' }), bareEnv, database, OWNER, ws.id, 'public', { nowMs: NOW, fetchImpl });
    expect(add.status).toBe(200);

    const resolved = await resolveDevAgentRepo(bareEnv, database, ws.id);
    expect(resolved?.repoFullName).toBe('vercel/next.js');
    expect(resolved?.auth).toEqual({ kind: 'public' });

    const del = await handleGithubApi(req('DELETE', '/x', { fullName: 'vercel/next.js' }), { ...(bareEnv as unknown as Record<string, unknown>), REPO_TOKEN_KEY: 'k' } as unknown as Env, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl });
    expect(del.status).toBe(204);
    expect(await listWorkspaceRepos(database, ws.id)).toEqual([]);
  });

  test('refresh pushes public repos token-less alongside tokened repos', async () => {
    const { fetchImpl } = githubStubWithPublic();
    const ws = await connectedWorkspace('pub-ws-4', fetchImpl);
    await handleGithubApi(req('PUT', '/x', { selected: ['Zabaca/cedarpad'] }), APP_ENV, database, OWNER, ws.id, 'repos', { nowMs: NOW, fetchImpl });
    await handleGithubApi(req('POST', '/x', { fullName: 'vercel/next.js' }), PAT_ENV, database, OWNER, ws.id, 'public', { nowMs: NOW, fetchImpl });

    const pushed: Array<{ repo: string; token: string | undefined }> = [];
    const res = await handleGithubApi(req('POST', '/x'), PAT_ENV, database, OWNER, ws.id, 'refresh', {
      nowMs: NOW,
      fetchImpl,
      pushRefresh: async (repo, token) => {
        pushed.push({ repo, token });
        return new Response(null, { status: 200 });
      },
    });
    expect(await readJson(res)).toEqual({ refreshed: ['Zabaca/cedarpad', 'vercel/next.js'], failed: [] });
    expect(pushed.find((p) => p.repo === 'Zabaca/cedarpad')?.token).toBe('ghs_stub');
    expect(pushed.find((p) => p.repo === 'vercel/next.js')?.token).toBeUndefined();
  });
});

describe('checkout refresh (ADR-0016) — the edge pushes read tokens to the container', () => {
  test('POST /refresh pushes one transient read token per repo; a member may trigger it', async () => {
    const { fetchImpl } = githubStubWithPat();
    const ws = await connectedWorkspace('refresh-ws', fetchImpl);
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });
    await handleGithubApi(req('PUT', '/x', { selected: ['Zabaca/cedarpad'] }), APP_ENV, database, OWNER, ws.id, 'repos', { nowMs: NOW, fetchImpl });
    await handleGithubApi(req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }), PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl });

    const pushed: Array<{ repo: string; token: string }> = [];
    const res = await handleGithubApi(req('POST', '/x'), PAT_ENV, database, MEMBER, ws.id, 'refresh', {
      nowMs: NOW,
      fetchImpl,
      pushRefresh: async (repo, token) => {
        pushed.push({ repo, token });
        return new Response(null, { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ refreshed: ['Zabaca/cedarpad', 'hudsonts/app'], failed: [] });
    // The installation repo got a minted read token; the PAT repo got the OPENED PAT.
    expect(pushed.find((p) => p.repo === 'Zabaca/cedarpad')?.token).toBe('ghs_stub');
    expect(pushed.find((p) => p.repo === 'hudsonts/app')?.token).toBe('github_pat_hudson');
  });

  test('adding a PAT repo seeds its checkout immediately (fire-and-forget push)', async () => {
    const { fetchImpl } = githubStubWithPat();
    const ws = await connectedWorkspace('refresh-ws-2', fetchImpl);
    const pushed: string[] = [];
    await handleGithubApi(req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }), PAT_ENV, database, OWNER, ws.id, 'external', {
      nowMs: NOW,
      fetchImpl,
      pushRefresh: async (repo, token) => {
        pushed.push(`${repo}:${token}`);
        return new Response(null, { status: 200 });
      },
    });
    // let the fire-and-forget microtask settle
    await new Promise((r) => setTimeout(r, 0));
    expect(pushed).toEqual(['hudsonts/app:github_pat_hudson']);
  });
});

describe('resolveDevAgentRepo — the unified repo set (ADR-0016)', () => {
  test('resolves installation and PAT repos with their auth; unknown requested is null', async () => {
    const { fetchImpl } = githubStubWithPat();
    const ws = await connectedWorkspace('resolve-ws', fetchImpl);
    await handleGithubApi(req('PUT', '/x', { selected: ['Zabaca/cedarpad'] }), APP_ENV, database, OWNER, ws.id, 'repos', { nowMs: NOW, fetchImpl });
    await handleGithubApi(req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }), PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl });

    const first = await resolveDevAgentRepo(PAT_ENV, database, ws.id);
    expect(first?.repoFullName).toBe('Zabaca/cedarpad');
    expect(first?.auth).toEqual({ kind: 'installation', installationId: '999' });

    const pat = await resolveDevAgentRepo(PAT_ENV, database, ws.id, 'hudsonts/app');
    expect(pat?.repoFullName).toBe('hudsonts/app');
    expect(pat?.auth.kind).toBe('pat');

    expect(await resolveDevAgentRepo(PAT_ENV, database, ws.id, 'Evil/other')).toBeNull();
  });

  test('a PAT repo resolves even with NO App installation connected', async () => {
    const ws = await createWorkspace(database, { name: 'pat-only-ws', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStubWithPat();
    await handleGithubApi(req('POST', '/x', { fullName: 'hudsonts/app', token: 'github_pat_hudson' }), PAT_ENV, database, OWNER, ws.id, 'external', { nowMs: NOW, fetchImpl });
    const resolved = await resolveDevAgentRepo(PAT_ENV, database, ws.id);
    expect(resolved?.repoFullName).toBe('hudsonts/app');
    expect(resolved?.auth.kind).toBe('pat');
  });
});

describe('handleGithubSetup — the install callback (#193)', () => {
  test('a bad or expired state is a 400; a non-owner of the named workspace is a 403', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws-6', ownerUserId: OWNER.id });
    await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id });
    const { fetchImpl } = githubStub();
    const bad = await handleGithubSetup(req('GET', '/api/github/setup?installation_id=999&state=garbage'), APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl });
    expect(bad.status).toBe(400);
    const expired = await handleGithubSetup(
      req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW - 1)}`),
      APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl },
    );
    expect(expired.status).toBe(400);
    const notOwner = await handleGithubSetup(
      req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW + 60_000)}`),
      APP_ENV, database, MEMBER, { nowMs: NOW, fetchImpl },
    );
    expect(notOwner.status).toBe(403);
  });

  test('an installation that belongs to a different App is rejected, nothing persisted', async () => {
    const ws = await createWorkspace(database, { name: 'gh-ws-7', ownerUserId: OWNER.id });
    const { fetchImpl } = githubStub({ installationApp: '99999' });
    const res = await handleGithubSetup(
      req('GET', `/api/github/setup?installation_id=999&state=${signState(SECRET, ws.id, NOW + 60_000)}`),
      APP_ENV, database, OWNER, { nowMs: NOW, fetchImpl },
    );
    expect(res.status).toBe(400);
    const row = await getWorkspace(database, ws.id, OWNER.id);
    expect(row?.githubInstallationId ?? null).toBeNull();
  });
});
