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
import { openSecret } from './secret-box.ts';

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

// How a repo authenticates (ADR-0016): via the workspace's App installation (edge mints
// short-lived scoped tokens), via a per-repo PAT (stored sealed, opened at use), or not at
// all — a public repo pasted onto the canvas carries no credential; reads ride the public
// HTTPS remote and writes are simply impossible. The discriminated union is the resolve→mint
// contract — callers spread a resolved repo into a mint call and never branch on the kind.
export type RepoAuth =
  | { kind: 'installation'; installationId: string }
  | { kind: 'pat'; encryptedToken: string }
  | { kind: 'public' };

async function openPat(env: Env, encryptedToken: string, context: string): Promise<string | null> {
  const key = env.REPO_TOKEN_KEY;
  if (!key) {
    console.log(`[${context}] REPO_TOKEN_KEY unset — cannot open the stored PAT, no git token`);
    return null;
  }
  const token = await openSecret(key, encryptedToken);
  if (!token) console.error(`[${context}] stored PAT failed to open (key rotated or row corrupt) — no git token`);
  return token;
}

// The coords-free mint core (ADR-0010 → ADR-0015 → ADR-0016): ONE repo credential for ONE
// dev-agent turn — the edge produces it per dev-agent send and rides it on the proxied
// request as a header (worker/inbox-bridge.ts). The repo + auth come from the workspace's
// repository connection (github-connection.ts resolveDevAgentRepo). Installation repos get a
// freshly-minted ~1h token scoped to exactly that repo; PAT repos get the sealed PAT opened
// at use (a PAT cannot be down-scoped — the ADR-0016 custody caveat). Best-effort: returns
// `null` (logging, never throwing) when unconfigured or the mint/open fails, so a send still
// proxies — the turn just runs without `open_pr` and the push/PR path surfaces its own error.
export async function mintDevAgentGitToken(
  env: Env,
  opts: { nowSec: number; repoFullName: string; auth: RepoAuth; fetchImpl?: typeof fetch },
): Promise<string | null> {
  if (opts.auth.kind === 'public') return null; // token-less by nature — no push/PR reach
  if (opts.auth.kind === 'pat') return openPat(env, opts.auth.encryptedToken, 'dev-agent');
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
      { appId, installationId: opts.auth.installationId, privateKey },
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

// Read-scoped repo credential (ADR-0016): job discovery and the repo checkout want read-only
// reach. Installation repos mint `contents: read` only; PAT repos return the opened PAT
// unchanged (down-scoping a PAT is not possible — its own scope is the boundary). Throws on
// installation-mint failure (callers are per-repo best-effort loops that log and continue).
export async function mintRepoReadToken(
  env: Env,
  opts: { nowSec: number; repoFullName: string; auth: RepoAuth; fetchImpl?: typeof fetch },
): Promise<string | null> {
  if (opts.auth.kind === 'public') return null; // reads work unauthenticated (public remote)
  if (opts.auth.kind === 'pat') return openPat(env, opts.auth.encryptedToken, 'repo-read');
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  const repoName = opts.repoFullName.split('/')[1] ?? opts.repoFullName;
  const { token } = await mintInstallationToken(
    { appId, installationId: opts.auth.installationId, privateKey },
    { repositories: [repoName], permissions: { contents: 'read' }, nowSec: opts.nowSec, fetchImpl: opts.fetchImpl },
  );
  return token;
}
