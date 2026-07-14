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

// The env var name the container git layer falls back to for clone/push/PR
// (`GITHUB_TOKEN_ENV` in server/repo-worktree.ts). The per-turn token now rides a request
// header into `createRepoWorktreeManager({ token })` (ADR-0010) rather than container env,
// but the name contract is kept pinned (github-app.test.ts) so the env fallback — and any
// operator-provisioned static token — can't drift from what the consumer reads (the consumer
// lives in a Bun-only module we don't want to bundle into the edge worker).
export const DEV_AGENT_GITHUB_TOKEN_ENV = 'DEV_AGENT_GITHUB_TOKEN';

// Minimum permissions for clone + push + open-PR. `metadata:read` is implicit. No `workflows`
// scope: a pushed branch that touches `.github/workflows/*` is rejected by GitHub without it,
// which enforces the dev-agent's "no CI changes" triage law rather than just stating it as a
// prompt rule. `issues` closes the explore loop: a run files its findings as ready-for-agent
// issues itself (requires Issues R/W granted on the App).
const DEV_AGENT_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write' } as const;

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
    /** Bare repo NAMES to scope to; omit for a token covering every granted repo
     *  (needed to LIST the grant itself, #193). */
    repositories?: string[];
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
    body: JSON.stringify({
      ...(opts.repositories ? { repositories: opts.repositories } : {}),
      permissions: opts.permissions,
    }),
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

// The coords-free mint core (ADR-0010 → ADR-0015): a freshly-minted installation token
// scoped to ONE repo for ONE dev-agent turn — the edge mints it per dev-agent send and rides
// it on the proxied request as a header (worker/inbox-bridge.ts). The installation + repo come
// from the workspace's repository connection (github-connection.ts resolveDevAgentRepo) — no
// hardcoded repo remains here. Best-effort: returns `null` (logging, never throwing) when the
// App is unconfigured or the mint fails, so a send still proxies — the turn just runs without
// `open_pr` and the push/PR path surfaces its own clear error.
export async function mintDevAgentGitToken(
  env: Env,
  opts: { nowSec: number; installationId: string; repoFullName: string; fetchImpl?: typeof fetch },
): Promise<string | null> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    console.log('[dev-agent] GitHub App not configured (GITHUB_APP_* unset) — no git token minted');
    return null;
  }
  // The installation is org-scoped, so the token request wants the bare repo NAME.
  const repoName = opts.repoFullName.split('/')[1] ?? opts.repoFullName;
  try {
    const { token } = await mintInstallationToken(
      { appId, installationId: opts.installationId, privateKey },
      {
        repositories: [repoName],
        permissions: { ...DEV_AGENT_PERMISSIONS },
        nowSec: opts.nowSec,
        fetchImpl: opts.fetchImpl,
      },
    );
    return token;
  } catch (e: unknown) {
    console.error(`[dev-agent] installation-token mint failed — no git token minted: ${String(e)}`);
    return null;
  }
}
