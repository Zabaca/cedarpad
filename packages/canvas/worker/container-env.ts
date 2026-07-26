import type { Env } from './index.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

// The canvas package's absolute path inside the container image — the SINGLE SOURCE OF
// TRUTH for the container runtime cwd (#133). The Agent SDK encodes the cwd into the
// on-disk project-dir name (projectDirForCwd), so a session written under one cwd but
// resumed under another is orphaned by name ("No conversation found") — exactly the
// failure that hit the product path when CANVAS_CWD moved in 5f53d3e. Two things must
// resolve to this same path or resume silently breaks:
//   • START's `cd` (sandbox-runtime.ts) → the interactive bridge's process.cwd()
//   • CANVAS_CWD injected below → the bridge's `query({ resume })` cwd
// Both derive from this constant, so they can't drift independently. (Dev-agent turns run
// under their prepared worktree instead — adoptSession moves the JSONL, ADR-0010 slice 6.)
// The Dockerfile `ENV CANVAS_CWD` is a matching image default; injecting it here makes
// this TS constant authoritative at runtime.
export const CANVAS_CONTAINER_CWD = '/app/agent-canvas/packages/canvas';

// Pure — no @cloudflare/sandbox dependency, unlike sandbox-runtime.ts (which imports
// this). That split matters for testability: sandbox-runtime.ts needs `cloudflare:workers`
// (only present in the real Workers runtime), so a plain `bun test` importing it must
// stub the whole module — and other test files already do that wholesale (worker/index.test.ts
// mocks `./sandbox-runtime.ts` entirely), which would silently swallow this function too if
// it lived there. Living in its own dependency-free file means it needs no mocking at all.

// Container env injected at process spawn (PRD: ANTHROPIC_API_KEY intentionally
// absent so it can't override the OAuth token).
export const containerEnv = (env: Env, coords: SandboxCoords): Record<string, string> => ({
  R2_BUCKET: env.R2_BUCKET,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT: env.R2_ENDPOINT,
  CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
  // Per-workspace R2 isolation (#46): the resolver derives this — `'default'` for the
  // legacy/prod container (preserving `workspaces/default/`), the workspace id otherwise.
  CANVAS_WORKSPACE: coords.canvasWorkspace,
  // web-poc mounted in the bridge: a real remote TURSO_URL makes it use Turso (not
  // the dev libSQL file); the origins line Better Auth up with poc.cedarpad.com.
  TURSO_URL: env.TURSO_URL ?? '',
  TURSO_KEY: env.TURSO_KEY ?? '',
  VOYAGE_API_KEY: env.VOYAGE_API_KEY ?? '',
  BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? '',
  BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? '',
  WEB_ORIGIN: env.WEB_ORIGIN ?? '',
  // The bridge's INBOX_USER (server/bridge.ts: `process.env.CANVAS_USER ?? 'default'`) —
  // without this, `ask_human` files every Conversation under the literal string
  // 'default', which never matches the Inbox UI's query by the real Better Auth user.id,
  // so promoted items silently never appear. See the Env.CANVAS_USER doc comment.
  CANVAS_USER: env.CANVAS_USER ?? '',
  // Single source of truth for the runtime cwd (#133): the bridge runs + resumes product
  // sessions with `cwd: CANVAS_CWD`, matching START's cd — one derivation, no drift that
  // could orphan a session's JSONL by project-dir name.
  CANVAS_CWD: CANVAS_CONTAINER_CWD,
  // Web push (#87): the `notify` seam lives in the bridge, so the VAPID keypair has to reach
  // the container — the one deliberate exception to "signing keys stay at the edge"
  // (GITHUB_APP_PRIVATE_KEY, LIVEKIT_*, REPO_TOKEN_KEY all stay behind). The capability is
  // narrow: sign a push to an endpoint already in `push_subscriptions`, read nothing. Unset ⇒
  // `webPushSender` returns null and notify degrades to its log line.
  VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY ?? '',
  VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY ?? '',
  VAPID_SUBJECT: env.VAPID_SUBJECT ?? '',
});

// Env for the warehouse container (ADR-0017, #236) — deliberately just the R2 S3 creds
// it needs to write parquet under workspaces/<ws>/warehouse/. No CLAUDE_CODE_OAUTH_TOKEN,
// no Turso/auth secrets, no future extraction secret: the second container class exists
// so those are structurally unreachable from it, not merely undialed by convention.
export const warehouseContainerEnv = (env: Env): Record<string, string> => ({
  R2_BUCKET: env.R2_BUCKET,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT: env.R2_ENDPOINT,
});
