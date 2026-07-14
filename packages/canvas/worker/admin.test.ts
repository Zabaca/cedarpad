import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { handleAdminApi } from './admin.ts';

// In-memory DB built from the real migrations (mirrors members.test.ts).
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}

const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

const ADMIN = { id: 'admin_a1', email: 'admin_a1@example.com' };
const PLEB = { id: 'pleb_a1', email: 'pleb_a1@example.com' };

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  await db.insert(schema.user).values({ id: ADMIN.id, name: 'Admin', email: ADMIN.email, role: 'admin' });
  await db.insert(schema.user).values({ id: PLEB.id, name: 'Pleb', email: PLEB.email });
});

// The D1 waitlist binding, faked at the same seam the route uses (prepare → all).
const fakeWaitlist = (rows: Array<{ email: string; created_at: string }>) => ({
  prepare: (sql: string) => {
    expect(sql.toLowerCase()).toContain('select');
    return { all: async () => ({ results: rows }) };
  },
});

const req = () => new Request('https://x/api/admin/waitlist', { method: 'GET' });

describe('handleAdminApi — /api/admin/waitlist is role=admin only (ADR-0014)', () => {
  test('an admin reads the waitlist (email + createdAt)', async () => {
    const res = await handleAdminApi(
      req(),
      database,
      ADMIN,
      fakeWaitlist([{ email: 'a@x.com', created_at: '2026-07-14 19:00:00' }]) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [{ email: 'a@x.com', createdAt: '2026-07-14 19:00:00' }] });
  });

  test('a non-admin user is refused (403) without touching the waitlist DB', async () => {
    const res = await handleAdminApi(req(), database, PLEB, {
      prepare: () => {
        throw new Error('must not be queried');
      },
    } as never);
    expect(res.status).toBe(403);
  });

  test('a missing waitlist binding (local dev) is a 503, not a crash', async () => {
    const res = await handleAdminApi(req(), database, ADMIN, undefined);
    expect(res.status).toBe(503);
  });
});
