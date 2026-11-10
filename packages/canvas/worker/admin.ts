import { eq } from 'drizzle-orm';
import type { Database } from '../web-poc/lib/db/index.ts';
import { user } from '../web-poc/lib/db/schema.ts';
import type { GateUser } from './auth-gate.ts';

// Admin surface (ADR-0014): lives inside the app worker, gated on the Better Auth
// admin role (`user.role === 'admin'`, assigned by data update — no signup path sets
// it). First verb: read the waitlist, which lives in the www worker's D1 database
// and is ALSO bound to this worker exactly so admin gets this view.

/** The slice of a D1Database binding this route uses (test seam). */
export interface WaitlistDb {
  prepare(sql: string): { all(): Promise<{ results: unknown[] }> };
}

/** Whether this user holds the Better Auth admin role (assigned by data update only). */
export async function isAdmin(database: Database, userId: string): Promise<boolean> {
  const [row] = await database.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.role === 'admin';
}

/**
 * /api/admin/waitlist
 *   GET → { entries: [{ email, createdAt }] } newest first — role=admin only (403).
 * A deployment without the D1 binding (local dev) answers 503, never crashes.
 */
export async function handleAdminApi(
  request: Request,
  database: Database,
  gateUser: GateUser,
  waitlist: WaitlistDb | undefined,
): Promise<Response> {
  if (!(await isAdmin(database, gateUser.id))) return Response.json({ error: 'admin only' }, { status: 403 });

  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  if (!waitlist) return Response.json({ error: 'waitlist database not bound' }, { status: 503 });

  const { results } = await waitlist.prepare('SELECT email, created_at FROM waitlist ORDER BY id DESC').all();
  const entries = (results as Array<{ email: string; created_at: string }>).map((r) => ({
    email: r.email,
    createdAt: r.created_at,
  }));
  return Response.json({ entries });
}
