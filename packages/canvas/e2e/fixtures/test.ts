/**
 * Project-local Playwright `test`, extended with the AUTHENTICATED fixtures (#276).
 *
 * Specs import `test` / `expect` from here rather than from `@playwright/test` directly, so
 * per-project fixtures land in one place. What lives here now:
 *
 * - `signIn()` — a real Better Auth account, created through the edge's own `/api/auth/*`
 *   handler and carrying its session cookie. NOT a shim: local dev leaves signup open
 *   (`server/dev-worker-config.ts` drops `AUTH_DISABLE_SIGNUP`), so e2e uses the same door a
 *   dev user does, and the session is verified by the same `worker/auth-gate.ts` prod runs.
 * - `joinBridgeWorkspace()` — the one piece of state no API can create: membership of the
 *   workspace the container files its Conversations into. Seeded straight into the local D1,
 *   as `scripts/seed-default-workspace.ts` does for production.
 *
 * Both are addressed at the EDGE ORIGIN, not vite's. In production the edge is in front of
 * everything; in local dev it sits BESIDE vite (which proxies only `/api/auth/*` and `/v1/*`
 * to it — see vite.config.ts), so a spec that wants the real gate must talk to the Worker's
 * own port. `with-worktree-port.sh` derives it per worktree as `CANVAS_EDGE_PORT`.
 *
 * See `.claude/skills/worktree/SKILL.md` for the full picture, including the one `E2E_MODE`
 * shim this leans on (local dev has no container, so the edge proxies to the bridge).
 */
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { type APIRequestContext, test as base, expect, request as apiRequest } from '@playwright/test';

import { requireLocalD1File } from '../../server/local-d1.ts';

/** The edge Worker's own origin — the gate, as production has it in front of every request. */
export const EDGE_BASE_URL = process.env.CANVAS_EDGE_URL ?? `http://localhost:${process.env.CANVAS_EDGE_PORT ?? 4513}`;

/** The workspace the bridge files its Conversations into (server/bridge.ts reads the same env). */
export const BRIDGE_WORKSPACE = process.env.CANVAS_WORKSPACE ?? 'default';

/** A signed-in user: their Better Auth id, and a request context carrying their session. */
export interface E2eUser {
  id: string;
  email: string;
  /** Bound to `EDGE_BASE_URL`, so every request through it passes the edge's gate. */
  request: APIRequestContext;
}

/**
 * Where the `setup` project parks the owning user's session (see e2e/specs/auth.setup.ts).
 * Under this worktree's own `test-results/`, so parallel worktrees never share one.
 */
export const OWNER_STATE = fileURLToPath(new URL('../../test-results/.auth/owner.json', import.meta.url));

export interface AuthFixtures {
  /** Create a fresh account and return it signed in. No workspace, so it owns nothing. */
  signIn: () => Promise<E2eUser>;
  /** Make `user` a member of the bridge's workspace — an owner of what it files there.
   *  ONE writer only: the `setup` project. See the warning on `OWNER_STATE`'s neighbour below. */
  joinBridgeWorkspace: (user: E2eUser) => Promise<void>;
  /** The signed-in user who OWNS what the bridge files — seeded once by the `setup` project.
   *  Request context only: no test needs its id, and not re-signing-in per test is the point. */
  owner: APIRequestContext;
  /** An anonymous request context at the edge origin — the deny side of a gate assertion. */
  edgeRequest: APIRequestContext;
}

export const test = base.extend<AuthFixtures>({
  signIn: async ({}, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async () => {
      // Unique per call so parallel workers and repeat runs never collide on the user row.
      const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const request = await apiRequest.newContext({ baseURL: EDGE_BASE_URL });
      contexts.push(request);
      const res = await request.post('/api/auth/sign-up/email', {
        data: { email, password: 'e2e-password-276', name: 'E2E User' },
      });
      if (!res.ok()) throw new Error(`sign-up failed (${res.status()}): ${await res.text()}`);
      const { user } = (await res.json()) as { user: { id: string } };
      return { id: user.id, email, request };
    });
    for (const context of contexts) await context.dispose();
  },

  /**
   * WRITES THE LIVE D1 — call it ONLY from the `setup` project.
   *
   * The edge Worker holds the same SQLite file open, and D1's write lock admits one writer:
   * an external write landing mid-request makes MINIFLARE's write fail, which surfaces as a
   * sign-up 422 or a `conversation.start failed: 500` in an unrelated parallel test. Measured,
   * not theorized — seeding per test made ~25% of a 4-worker run fail that way. Serialized
   * into the one-shot `setup` project, where nothing else is in flight, it is stable.
   */
  joinBridgeWorkspace: async ({}, use) => {
    await use(async (user) => {
      const db = createClient({ url: `file:${requireLocalD1File()}` });
      try {
        // The workspace row itself: `default` is the legacy id the container still files under,
        // and it has no creating API (#179 seeded it in production by hand). The first run
        // creates it, later runs join the existing one — so this is idempotent across runs.
        await db.execute({
          sql: 'insert into workspaces (id, name, owner_user_id) values (?, ?, ?) on conflict do nothing',
          args: [BRIDGE_WORKSPACE, 'E2E', user.id],
        });
        await db.execute({
          sql: 'insert into workspace_members (id, workspace_id, user_id, role) values (?, ?, ?, ?) on conflict do nothing',
          args: [`wm_e2e_${user.id}`, BRIDGE_WORKSPACE, user.id, 'member'],
        });
      } finally {
        db.close();
      }
    });
  },

  owner: async ({}, use) => {
    const request = await apiRequest.newContext({ baseURL: EDGE_BASE_URL, storageState: OWNER_STATE });
    await use(request);
    await request.dispose();
  },

  edgeRequest: async ({}, use) => {
    const request = await apiRequest.newContext({ baseURL: EDGE_BASE_URL });
    await use(request);
    await request.dispose();
  },
});

export { expect };
