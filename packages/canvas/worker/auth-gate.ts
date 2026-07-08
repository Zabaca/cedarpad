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

/** A resolved Better Auth user (the only field the gate needs). */
export interface GateUser {
  id: string;
}

/** A resolved session, or null when there is none / it is expired / it is invalid. */
export type ResolvedSession = { user: GateUser } | null;

export type Gate = { decision: 'allow'; user: GateUser | null } | { decision: 'deny' };

/**
 * Paths served WITHOUT a session so a user can authenticate at the edge:
 * `/health` (unauthenticated probe), the Better Auth endpoints themselves
 * (`/api/auth/*` — login/logout/session), and `/api/buildrev` (#74 — the container's
 * public build stamp deploy.sh polls to confirm a rollout, no session available).
 * Everything else — including the sensitive/mutating `/api/status`, `/__recycle`,
 * `/__bootlog` — is behind the gate.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/api/buildrev' ||
    pathname === '/api/auth' ||
    pathname.startsWith('/api/auth/')
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

/** Build the edge Better Auth instance against remote Turso (the integration seam). */
function edgeAuth(env: Env) {
  const db = createDbForWorker(env as unknown as Bindings);
  return createAuth(db, env as unknown as Bindings);
}

/**
 * Verify the request's Better Auth session against remote Turso.
 * Returns `{ user }` for a valid session, else null (no cookie / expired / invalid).
 */
export async function authenticate(request: Request, env: Env): Promise<ResolvedSession> {
  const session = await edgeAuth(env)
    .api.getSession({ headers: request.headers })
    .catch(() => null);
  return session?.user ? { user: { id: session.user.id } } : null;
}

/** Serve the Better Auth endpoints at the edge (login/logout/session), so auth relocates here. */
export function handleAuth(request: Request, env: Env): Promise<Response> {
  return edgeAuth(env).handler(request);
}
