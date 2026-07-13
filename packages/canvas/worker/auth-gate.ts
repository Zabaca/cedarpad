import { createAuth } from '../web-poc/worker/auth.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import type { Env } from './index.ts';

// The edge auth gate (ADR-0007, slice #45). Better Auth session verification runs
// at the edge, AHEAD of the resolver/proxy, so an unauthenticated request never
// reaches a container. It reuses web-poc's Better Auth config (`createAuth`) and the
// SAME remote Turso (users/sessions) that Notebook's `/v1/*` verifies against — one
// auth system across the platform. Session lookup (Turso + crypto) is integration-only;
// the PURE gate DECISION (`decideGate`) is split out so it's unit-testable off a DB.

/** A resolved Better Auth user. The gate needs only `id`; the invite accept flow
 * (#179) also reads `email` to verify the invitation's binding. */
export interface GateUser {
  id: string;
  email?: string;
}

/** A resolved session, or null when there is none / it is expired / it is invalid. */
export type ResolvedSession = { user: GateUser } | null;

export type Gate = { decision: 'allow'; user: GateUser | null } | { decision: 'deny' };

/**
 * Paths served WITHOUT a session so a user can authenticate at the edge:
 * `/health` (unauthenticated probe), the Better Auth endpoints themselves
 * (`/api/auth/*` — login/logout/session), `/api/buildrev` (#74 — the container's
 * public build stamp deploy.sh polls to confirm a rollout, no session available),
 * and `/invite/<token>` (#179 — the invitee has no session yet; the email-bound
 * single-use token IS the credential, validated by the handler).
 * Everything else — including the sensitive/mutating `/api/status`, `/__recycle`,
 * `/__bootlog` — is behind the gate.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/api/buildrev' ||
    pathname === '/api/auth' ||
    pathname.startsWith('/api/auth/') ||
    /^\/invite\/[^/]+$/.test(pathname)
  );
}

/**
 * Pure gate decision: public paths and valid sessions pass; anything else is denied.
 * `session` is null for no-cookie, expired, or invalid sessions (Better Auth collapses
 * all three to null), so those all deny — the container is never proxied to.
 */
export function decideGate(pathname: string, session: ResolvedSession): Gate {
  if (isPublicPath(pathname)) return { decision: 'allow', user: session?.user ?? null };
  return session?.user ? { decision: 'allow', user: session.user } : { decision: 'deny' };
}

/** Build the edge Better Auth instance against remote Turso (the integration seam).
 * Memoized per isolate: the db client is already shared (createDbForWorker caches), and
 * rebuilding the Better Auth wrapper per request was pure waste on the hot gate path. */
let cachedAuth: { db: unknown; auth: ReturnType<typeof createAuth> } | null = null;
function edgeAuth(env: Env) {
  const db = createDbForWorker(env as unknown as Bindings);
  if (cachedAuth?.db !== db) cachedAuth = { db, auth: createAuth(db, env as unknown as Bindings) };
  return cachedAuth.auth;
}

/**
 * Verify the request's Better Auth session against remote Turso.
 * Returns `{ user }` for a valid session, else null (no cookie / expired / invalid).
 */
export async function authenticate(request: Request, env: Env): Promise<ResolvedSession> {
  const session = await edgeAuth(env)
    .api.getSession({ headers: request.headers })
    .catch(() => null);
  return session?.user ? { user: { id: session.user.id, email: session.user.email } } : null;
}

/**
 * #179: the guarded account-creation door. Builds a per-request Better Auth instance
 * with signup ENABLED — while the global AUTH_DISABLE_SIGNUP stays "true" — so an
 * account can be created ONLY through the invite-accept handler, after the email-bound
 * token has been validated. Never expose this outside that path.
 */
export function inviteSignUp(env: Env) {
  return async (input: { email: string; name: string; password: string }): Promise<{ userId: string; setCookie: string }> => {
    const db = createDbForWorker(env as unknown as Bindings);
    const auth = createAuth(db, { ...(env as unknown as Bindings), AUTH_DISABLE_SIGNUP: 'false' });
    const { headers, response } = await auth.api.signUpEmail({
      body: { email: input.email, name: input.name, password: input.password },
      returnHeaders: true,
    });
    return { userId: response.user.id, setCookie: headers.get('set-cookie') ?? '' };
  };
}

/** Serve the Better Auth endpoints at the edge (login/logout/session), so auth relocates here. */
export function handleAuth(request: Request, env: Env): Promise<Response> {
  return edgeAuth(env).handler(request);
}
