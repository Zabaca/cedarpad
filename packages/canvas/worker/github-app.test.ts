import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import {
  DEV_AGENT_GITHUB_TOKEN_ENV,
  appConfigFromEnv,
  buildAppJwt,
  mintDevAgentGitToken,
  mintInstallationToken,
  mintRepoReadToken,
} from './github-app.ts';
import { sealSecret } from './secret-box.ts';
import { GITHUB_TOKEN_ENV } from '../server/repo-worktree.ts';
import type { Env } from './index.ts';

// A throwaway RSA keypair so the JWT is really signed and really verifiable — GitHub issues a
// PKCS#1 key, and node:crypto signs/verifies that form directly (the whole reason we don't
// need a PKCS#8 conversion).
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const cfg = { appId: '4257337', installationId: '145473731', privateKey };
const decode = (seg: string) => JSON.parse(Buffer.from(seg, 'base64url').toString());

describe('buildAppJwt', () => {
  test('emits a real RS256 JWT whose signature verifies with the matching public key', () => {
    const jwt = buildAppJwt(cfg, 1_700_000_000);
    const [h, p, sig] = jwt.split('.');
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const v = createVerify('RSA-SHA256').update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  test('claims: iss is the App id, iat is backdated 60s, exp is under GitHub 10-min ceiling', () => {
    const now = 1_700_000_000;
    const { iss, iat, exp } = decode(buildAppJwt(cfg, now).split('.')[1]);
    expect(iss).toBe('4257337');
    expect(iat).toBe(now - 60);
    expect(exp).toBe(now + 540);
    expect(exp - now).toBeLessThan(600); // GitHub rejects a JWT whose exp is >10 min past the real now
  });
});

describe('mintInstallationToken', () => {
  test('POSTs to the installation access-tokens endpoint with the JWT as a Bearer + scoped body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ token: 'ghs_minted', expires_at: '2026-07-09T10:00:00Z' }), { status: 201 });
    }) as unknown as typeof fetch;

    const res = await mintInstallationToken(cfg, {
      repositories: ['cedarpad'],
      permissions: { contents: 'write', pull_requests: 'write' },
      nowSec: 1_700_000_000,
      fetchImpl: fakeFetch,
    });

    expect(res).toEqual({ token: 'ghs_minted', expiresAt: '2026-07-09T10:00:00Z' });
    expect(captured!.url).toBe('https://api.github.com/app/installations/145473731/access_tokens');
    expect(captured!.init.method).toBe('POST');
    const auth = new Headers(captured!.init.headers).get('Authorization')!;
    expect(auth.startsWith('Bearer ')).toBe(true);
    // the Bearer value is exactly the JWT we'd build for this instant
    expect(auth).toBe(`Bearer ${buildAppJwt(cfg, 1_700_000_000)}`);
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      repositories: ['cedarpad'],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });

  test('a non-2xx response throws with the status (never silently returns an empty token)', async () => {
    const fakeFetch = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    await expect(
      mintInstallationToken(cfg, { repositories: ['cedarpad'], permissions: {}, nowSec: 1, fetchImpl: fakeFetch }),
    ).rejects.toThrow('401');
  });
});

describe('appConfigFromEnv', () => {
  test('returns the config when all three secrets are present', () => {
    const env = { GITHUB_APP_ID: 'a', GITHUB_APP_INSTALLATION_ID: 'b', GITHUB_APP_PRIVATE_KEY: 'c' } as Env;
    expect(appConfigFromEnv(env)).toEqual({ appId: 'a', installationId: 'b', privateKey: 'c' });
  });

  test('returns null (not throws) when any one is missing', () => {
    expect(appConfigFromEnv({ GITHUB_APP_ID: 'a', GITHUB_APP_INSTALLATION_ID: 'b' } as Env)).toBeNull();
    expect(appConfigFromEnv({} as Env)).toBeNull();
  });
});

describe('mintDevAgentGitToken — the per-turn, per-repo mint core (ADR-0010 → ADR-0015 → ADR-0016)', () => {
  const env = { GITHUB_APP_ID: '4257337', GITHUB_APP_PRIVATE_KEY: privateKey } as Env;
  const repo = {
    repoFullName: 'Zabaca/cedarpad',
    auth: { kind: 'installation', installationId: '145473731' },
  } as const;

  test('mints a token scoped to the RESOLVED repo (contents/PRs/issues write) via the injected fetch', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse((init?.body as string) ?? 'null') };
      return new Response(JSON.stringify({ token: 'ghs_minted', expires_at: 'x' }), { status: 201 });
    }) as unknown as typeof fetch;

    const token = await mintDevAgentGitToken(env, { nowSec: 1_700_000_000, ...repo, fetchImpl: fakeFetch });

    expect(token).toBe('ghs_minted');
    // The INSTALLATION comes from the workspace's connection, not env (ADR-0015).
    expect(captured!.url).toBe('https://api.github.com/app/installations/145473731/access_tokens');
    // GitHub wants the bare repo NAME (the installation is org-scoped).
    expect(captured!.body).toEqual({
      repositories: ['cedarpad'],
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
    });
  });

  test('best-effort: unconfigured App ⇒ null (a send proxies token-less, never throws)', async () => {
    expect(await mintDevAgentGitToken({} as Env, { nowSec: 1, ...repo })).toBeNull();
  });

  test('best-effort: a mint failure ⇒ null (never throws into the proxy path)', async () => {
    const boom = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await mintDevAgentGitToken(env, { nowSec: 1, ...repo, fetchImpl: boom })).toBeNull();
  });

  test('the token is the ONLY credential produced — the private key never leaves the mint', async () => {
    const okFetch = (async () =>
      new Response(JSON.stringify({ token: 'ghs_minted', expires_at: 'x' }), { status: 201 })) as unknown as typeof fetch;
    const token = await mintDevAgentGitToken(env, { nowSec: 1, ...repo, fetchImpl: okFetch });
    expect(token).toBe('ghs_minted');
    expect(token).not.toContain('PRIVATE KEY');
  });
});

describe('mintDevAgentGitToken — the PAT arm (ADR-0016: no App call, decrypt-at-use)', () => {
  test('opens the sealed PAT with the platform key — GitHub is never called', async () => {
    const sealed = await sealSecret('platform-key', 'github_pat_hudson');
    const neverFetch = (async () => {
      throw new Error('the PAT arm must not call GitHub');
    }) as unknown as typeof fetch;
    const token = await mintDevAgentGitToken({ REPO_TOKEN_KEY: 'platform-key' } as Env, {
      nowSec: 1,
      repoFullName: 'hudsonts/app',
      auth: { kind: 'pat', encryptedToken: sealed },
      fetchImpl: neverFetch,
    });
    expect(token).toBe('github_pat_hudson');
  });

  test('best-effort: missing platform key or an unopenable seal ⇒ null, never a throw', async () => {
    const sealed = await sealSecret('platform-key', 'tok');
    expect(
      await mintDevAgentGitToken({} as Env, { nowSec: 1, repoFullName: 'a/b', auth: { kind: 'pat', encryptedToken: sealed } }),
    ).toBeNull();
    expect(
      await mintDevAgentGitToken({ REPO_TOKEN_KEY: 'other-key' } as Env, {
        nowSec: 1,
        repoFullName: 'a/b',
        auth: { kind: 'pat', encryptedToken: sealed },
      }),
    ).toBeNull();
  });
});

describe('mintRepoReadToken — read-scoped tokens for discovery/checkout (ADR-0016)', () => {
  const env = { GITHUB_APP_ID: '4257337', GITHUB_APP_PRIVATE_KEY: privateKey } as Env;

  test('installation repos mint a contents:read-only installation token', async () => {
    let captured: { body: unknown } | null = null;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = { body: JSON.parse((init?.body as string) ?? 'null') };
      return new Response(JSON.stringify({ token: 'ghs_read', expires_at: 'x' }), { status: 201 });
    }) as unknown as typeof fetch;
    const token = await mintRepoReadToken(env, {
      nowSec: 1_700_000_000,
      repoFullName: 'Zabaca/cedarpad',
      auth: { kind: 'installation', installationId: '145473731' },
      fetchImpl: fakeFetch,
    });
    expect(token).toBe('ghs_read');
    expect(captured!.body).toEqual({ repositories: ['cedarpad'], permissions: { contents: 'read' } });
  });

  test('PAT repos return the decrypted PAT (a PAT cannot be down-scoped — ADR-0016 caveat)', async () => {
    const sealed = await sealSecret('platform-key', 'github_pat_hudson');
    const token = await mintRepoReadToken({ REPO_TOKEN_KEY: 'platform-key' } as Env, {
      nowSec: 1,
      repoFullName: 'hudsonts/app',
      auth: { kind: 'pat', encryptedToken: sealed },
    });
    expect(token).toBe('github_pat_hudson');
  });
});

// The env-var NAME contract across the edge/container boundary: the per-turn token now rides a
// request header into the git manager's config (ADR-0010), but repo-worktree.ts still falls back
// to process.env[GITHUB_TOKEN_ENV] — pin the names equal so a rename on either side can't
// silently break an operator-provisioned static token.
test('producer/consumer env-var name contract holds', () => {
  expect(DEV_AGENT_GITHUB_TOKEN_ENV).toBe(GITHUB_TOKEN_ENV);
});
