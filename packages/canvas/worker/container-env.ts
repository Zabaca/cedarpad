import type { Env } from './index.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

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
});
