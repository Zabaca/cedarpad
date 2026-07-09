import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import {
  DEV_AGENT_GITHUB_TOKEN_ENV,
  appConfigFromEnv,
  buildAppJwt,
  devAgentGitTokenEnv,
  mintInstallationToken,
} from './github-app.ts';
import { GITHUB_TOKEN_ENV } from '../server/repo-worktree.ts';
import { DEV_AGENT_SANDBOX_ID } from './dev-agent.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
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

describe('devAgentGitTokenEnv — only the dev-agent, private key never forwarded', () => {
  const devAgentCoords: SandboxCoords = {
    sandboxId: DEV_AGENT_SANDBOX_ID,
    r2Prefix: 'workspaces/dev-agent/',
    canvasWorkspace: 'dev-agent',
  };
  const productCoords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };
  const env = { GITHUB_APP_ID: '4257337', GITHUB_APP_INSTALLATION_ID: '145473731', GITHUB_APP_PRIVATE_KEY: privateKey } as Env;
  const okFetch = (async () =>
    new Response(JSON.stringify({ token: 'ghs_minted', expires_at: 'x' }), { status: 201 })) as unknown as typeof fetch;

  test('a PRODUCT workspace never mints (returns {} and does not call GitHub)', async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    expect(await devAgentGitTokenEnv(env, productCoords, { nowSec: 1, fetchImpl: spyFetch })).toEqual({});
    expect(called).toBe(false);
  });

  test('the dev-agent gets ONLY the minted token — the private key is never in the env fragment', async () => {
    const frag = await devAgentGitTokenEnv(env, devAgentCoords, { nowSec: 1, fetchImpl: okFetch });
    expect(frag).toEqual({ [DEV_AGENT_GITHUB_TOKEN_ENV]: 'ghs_minted' });
    expect(JSON.stringify(frag)).not.toContain('PRIVATE KEY');
  });

  test('best-effort: unconfigured App ⇒ {} (boot proceeds without a token)', async () => {
    expect(await devAgentGitTokenEnv({} as Env, devAgentCoords, { nowSec: 1, fetchImpl: okFetch })).toEqual({});
  });

  test('best-effort: a mint failure ⇒ {} (never throws into the boot path)', async () => {
    const boom = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await devAgentGitTokenEnv(env, devAgentCoords, { nowSec: 1, fetchImpl: boom })).toEqual({});
  });
});

// The edge produces the token under this var; the container's git layer reads GITHUB_TOKEN_ENV.
// They're defined in separate modules across the edge/container boundary — pin them equal so a
// rename on either side can't silently break clone/push/PR.
test('producer/consumer env-var name contract holds', () => {
  expect(DEV_AGENT_GITHUB_TOKEN_ENV).toBe(GITHUB_TOKEN_ENV);
});
