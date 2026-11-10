import { workspaceKey } from '../shared/workspace-key.ts';
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
// Both derive from this constant, so they can't drift independently.
// The Dockerfile `ENV CANVAS_CWD` is a matching image default; injecting it here makes
// this TS constant authoritative at runtime.
export const CANVAS_CONTAINER_CWD = '/app/agent-canvas/packages/canvas';

// Pure, and in its own file rather than in sandbox-runtime.ts (which imports this): other
// test files stub that module wholesale (worker/index.test.ts mocks `./sandbox-runtime.ts`
// entirely), which would silently swallow this function too if it lived there. Living in
// its own dependency-free file means it needs no mocking at all.

// Container env injected at process spawn (PRD: ANTHROPIC_API_KEY intentionally
// absent so it can't override the OAuth token).
export const containerEnv = async (env: Env, coords: SandboxCoords): Promise<Record<string, string>> => ({
  // The container holds NO R2 credential. Its chat meta and session transcripts go through the
  // edge (shared/workspace-blob.ts, authenticated by the workspace key below), which holds the
  // bucket as a binding and derives the keys, so a container can reach its own workspace's two
  // objects and nothing else in the bucket.
  WORKSPACE_BLOBS: 'edge',
  CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
  // Per-workspace R2 isolation (#46): the resolver derives this — `'default'` for the
  // legacy/prod container (preserving `workspaces/default/`), the workspace id otherwise.
  CANVAS_WORKSPACE: coords.canvasWorkspace,
  // ADR-0018 / #266 — the decision, and it is what is NOT here: no `TURSO_URL`, no `TURSO_KEY`.
  // The container holds no platform-data-layer client, so it is handed no connection string and
  // no credential; deleting those two lines IS this ADR. (`VOYAGE_API_KEY`, `BETTER_AUTH_URL`
  // and `WEB_ORIGIN` went with them — all three existed for the in-process web-poc mount that
  // the same slice removed. Better Auth is an edge route.) What remains below is
  // the container's key for talking to US, not to a database.
  //
  // #374: that key is `WORKSPACE_KEY`, derived for THIS workspace only (shared/workspace-key.ts),
  // and BETTER_AUTH_SECRET itself is deliberately NOT here any more. With the secret a container
  // could mint the bearer for any workspace and name any workspace's canvas; with its own key it
  // can authenticate to the EDGE as its own workspace and no other, and the secret cannot be
  // recovered from the key. Every bearer the container presents (platform RPC, canvas mutation,
  // asset read) is derived from this one value.
  WORKSPACE_KEY: env.BETTER_AUTH_SECRET ? await workspaceKey(env.BETTER_AUTH_SECRET, coords.canvasWorkspace) : '',
  // Single source of truth for the runtime cwd (#133): the bridge runs + resumes product
  // sessions with `cwd: CANVAS_CWD`, matching START's cd — one derivation, no drift that
  // could orphan a session's JSONL by project-dir name.
  CANVAS_CWD: CANVAS_CONTAINER_CWD,
  // The platform RPC endpoint (ADR-0018): the edge origin the container calls back on for the
  // two writes that originate inside it. Deliberately its OWN variable rather than reusing
  // WEB_ORIGIN — WEB_ORIGIN is also the Better Auth origin and local dev always fills it, so
  // keying the RPC off it would make a bridge with no edge in front of it (vite + bridge) post
  // into the void. Set ⇒ there is an edge; unset ⇒ the bridge keeps its direct client.
  PLATFORM_RPC_ORIGIN: env.WEB_ORIGIN ?? '',
  // Web push (#87) no longer needs anything here: delivery moved to the EDGE with ADR-0018
  // (it reads `push_subscriptions` and prunes dead endpoints, so it belongs on the side that
  // holds the platform data layer). The container asks for a ping by name over the platform
  // RPC instead, so the VAPID keypair — the one deliberate exception to "signing keys stay at
  // the edge" — stops reaching a container at all.
});
