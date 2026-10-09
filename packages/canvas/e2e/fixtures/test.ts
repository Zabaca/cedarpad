/**
 * Project-local Playwright `test`, extended with the AUTHENTICATED fixtures (#276).
 *
 * Specs import `test` / `expect` from here rather than from `@playwright/test` directly, so
 * per-project fixtures land in one place. What lives here now:
 *
 * - `signIn()` — a real Better Auth account, created through the edge's own `/api/auth/*`
 *   handler and carrying its session cookie. NOT a shim: it drives the same passwordless
 *   magic-link endpoints a real user does (request → verify), and the session is verified
 *   by the same `worker/auth-gate.ts` prod runs. The one thing it cannot do is read email,
 *   so it lifts the token out of D1 — see `readMagicLinkToken` for why that needs no
 *   test-only branch in production code.
 * - `joinBridgeWorkspace()` — the one piece of state no API can create: membership of the
 *   workspace the container serves. Seeded straight into the local D1
 *   (production's `default` workspace row was seeded the same way, by hand, once, #179).
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

/** The workspace the bridge serves (server/bridge.ts reads the same env). */
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
  /** Give `user` Better Auth's `admin` role. Same one-writer rule as `joinBridgeWorkspace`:
   *  the `setup` project only. */
  promoteToAdmin: (user: E2eUser) => Promise<void>;
  /** An anonymous request context at the edge origin — the deny side of a gate assertion. */
  edgeRequest: APIRequestContext;
}

/**
 * Recover the magic-link token for `email` from the local D1.
 *
 * Passwordless sign-in normally crosses an email hop a headless test cannot follow.
 * Rather than shim the send path, this reads what Better Auth already stores: the
 * plugin writes the token to `verification` (as `identifier`, in PLAIN form by
 * default) before invoking the send seam, keying the row's `value` to the address.
 * READ-ONLY — the D1 write-lock warning on `joinBridgeWorkspace` does not apply.
 */
async function readMagicLinkToken(email: string): Promise<string> {
  const db = createClient({ url: `file:${requireLocalD1File()}` });
  try {
    const rows = await db.execute({
      sql: 'SELECT identifier FROM verification WHERE value LIKE ? ORDER BY created_at DESC LIMIT 1',
      args: [`%"${email}"%`],
    });
    const token = rows.rows[0]?.identifier;
    if (typeof token !== 'string') throw new Error(`no magic-link token stored for ${email}`);
    return token;
  } finally {
    db.close();
  }
}

export const test = base.extend<AuthFixtures>({
  signIn: async ({}, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async () => {
      // Unique per call so parallel workers and repeat runs never collide on the user row.
      const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const request = await apiRequest.newContext({ baseURL: EDGE_BASE_URL });
      contexts.push(request);

      // Ask for a magic link. Locally there is no EMAIL binding, so nothing is actually
      // sent — but Better Auth persists the token BEFORE it tries to send, so the link
      // is recoverable from D1 without a test-only hook in production code.
      // `name` is carried on the request and applied when verification creates the
      // user — without it the display name falls back to the email's local part, and
      // specs that assert on a collaborator's name (canvas-presence) would read a
      // random per-run string.
      const asked = await request.post('/api/auth/sign-in/magic-link', {
        data: { email, name: 'E2E User', callbackURL: '/' },
      });
      if (!asked.ok()) throw new Error(`magic-link request failed (${asked.status()}): ${await asked.text()}`);

      const token = await readMagicLinkToken(email);
      const verified = await request.get(`/api/auth/magic-link/verify?token=${token}&callbackURL=/`);
      if (!verified.ok()) throw new Error(`magic-link verify failed (${verified.status()}): ${await verified.text()}`);

      // The session cookie now lives on `request`; ask the edge who it thinks we are.
      const session = await request.get('/api/auth/get-session');
      if (!session.ok()) throw new Error(`get-session failed (${session.status()}): ${await session.text()}`);
      const body = (await session.json()) as { user?: { id: string } } | null;
      if (!body?.user) throw new Error('magic-link verify did not establish a session');
      return { id: body.user.id, email, request };
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

  /**
   * WRITES THE LIVE D1 — `setup` project only, for the reason on `joinBridgeWorkspace`.
   *
   * The snapshot door the migration loads through is ADMIN-gated, not member-gated
   * (worker/canvas-snapshot-api.ts: replacing a canvas's whole document is an operator
   * action). No signup path sets the role, so the migration spec (#321) has no way to reach
   * that door unless the owner — who IS the operator here — carries it.
   */
  promoteToAdmin: async ({}, use) => {
    await use(async (user) => {
      const db = createClient({ url: `file:${requireLocalD1File()}` });
      try {
        await db.execute({ sql: 'update user set role = ? where id = ?', args: ['admin', user.id] });
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
