// GitHub App installation-token minting, at the EDGE (#96). Replaces the static
// DEV_AGENT_GITHUB_TOKEN PAT stub (server/repo-worktree.ts) with short-lived, repo-scoped
// tokens minted from the App private key.
//
// Security shape (ADR-0008): the App private key is the durable identity and stays HERE, in
// the edge Worker — it is NEVER forwarded into the container (the RCE trust boundary). The
// only credential that reaches the container is the ~1h installation token this mints, scoped
// to the one repo + the minimum permissions. A leaked token self-heals on expiry; the key
// never leaves the edge.
//
// node:crypto (nodejs_compat is on) signs the App JWT. GitHub issues a PKCS#1 key
// ("BEGIN RSA PRIVATE KEY"); node:crypto's createSign consumes that directly, so no
// PKCS#1→PKCS#8 conversion is needed (crypto.subtle would have required it).
import { createSign } from 'node:crypto';

import type { Env } from './index.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { DEV_AGENT_SANDBOX_ID } from './dev-agent.ts';

// The container env var the dev-agent's git layer reads for clone/push/PR. This is the
// producer side of the contract; the consumer is `GITHUB_TOKEN_ENV` in
// server/repo-worktree.ts. github-app.test.ts pins the two equal so they can't drift (the
// consumer lives in a Bun-only module we don't want to bundle into the edge worker).
export const DEV_AGENT_GITHUB_TOKEN_ENV = 'DEV_AGENT_GITHUB_TOKEN';

// The single repo the dev-agent operates on today (mirrors DEFAULT_REPO in repo-worktree.ts).
// The installation token is scoped to just this repo's NAME (the installation is already
// org-scoped, so GitHub wants the bare name, not `owner/repo`).
const DEV_AGENT_REPO_NAME = 'cedarpad';

// Minimum permissions for clone + push + open-PR. `metadata:read` is implicit. `workflows`
// is included because a pushed branch that touches `.github/workflows/*` is rejected without
// it, and the dev-agent may edit CI.
const DEV_AGENT_PERMISSIONS = { contents: 'write', pull_requests: 'write', workflows: 'write' } as const;

export interface GithubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string; // PKCS#1 PEM, as GitHub issues it
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

// A short-lived App JWT (RS256), signed with the App private key. `nowSec` is injected so the
// claims are deterministic under test. Per GitHub guidance: `iat` backdated 60s for clock
// skew, `exp` well under the 10-minute ceiling.
export function buildAppJwt(cfg: GithubAppConfig, nowSec: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSec - 60, exp: nowSec + 540, iss: cfg.appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(cfg.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

// Exchange the App JWT for an installation token scoped to `repositories` + `permissions`.
// `fetchImpl` is injected for tests; production passes the edge `fetch`.
export async function mintInstallationToken(
  cfg: GithubAppConfig,
  opts: {
    repositories: string[];
    permissions: Record<string, string>;
    nowSec: number;
    fetchImpl?: typeof fetch;
  },
): Promise<InstallationToken> {
  const jwt = buildAppJwt(cfg, opts.nowSec);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/app/installations/${cfg.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cedarpad-dev-agent',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ repositories: opts.repositories, permissions: opts.permissions }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub installation-token mint failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { token: string; expires_at: string };
  return { token: json.token, expiresAt: json.expires_at };
}

// Read the three App secrets from the Worker env. Returns null (not throws) when any is
// absent so callers can degrade gracefully — a dev-agent boot with no App configured should
// proceed and let the push/PR path surface its own clear "token not set" error, not 500 the
// whole container boot.
export function appConfigFromEnv(env: Env): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !privateKey) return null;
  return { appId, installationId, privateKey };
}

// The env fragment the DEV-AGENT container gets, and only it: a freshly-minted, cedarpad-scoped
// installation token under the var repo-worktree.ts reads. Returns `{}` for every non-dev-agent
// coords (so no product workspace mints a token) and — best-effort — `{}` if the App isn't
// configured or the mint fails, logging rather than throwing so a chat resume still boots.
export async function devAgentGitTokenEnv(
  env: Env,
  coords: SandboxCoords,
  opts: { nowSec: number; fetchImpl?: typeof fetch },
): Promise<Record<string, string>> {
  if (coords.sandboxId !== DEV_AGENT_SANDBOX_ID) return {};
  const cfg = appConfigFromEnv(env);
  if (!cfg) {
    console.log('[dev-agent] GitHub App not configured (GITHUB_APP_* unset) — booting without a git token');
    return {};
  }
  try {
    const { token } = await mintInstallationToken(cfg, {
      repositories: [DEV_AGENT_REPO_NAME],
      permissions: { ...DEV_AGENT_PERMISSIONS },
      nowSec: opts.nowSec,
      fetchImpl: opts.fetchImpl,
    });
    return { [DEV_AGENT_GITHUB_TOKEN_ENV]: token };
  } catch (e: unknown) {
    console.error(`[dev-agent] installation-token mint failed — booting without a git token: ${String(e)}`);
    return {};
  }
}
