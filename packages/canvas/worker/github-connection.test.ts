import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { createWorkspace, getWorkspace, addWorkspaceMember } from '../web-poc/lib/db/queries/workspaces.ts';
import { handleGithubApi, handleGithubSetup, signState, verifyState } from './github-connection.ts';
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
