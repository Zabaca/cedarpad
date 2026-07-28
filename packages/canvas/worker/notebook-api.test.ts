import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { makeDb, schema } from '../web-poc/lib/db/index.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { buildApp } from '../web-poc/worker/index.ts';

// Edge-level coverage for #56: Notebook's Hono API served at the edge against an
// injected (in-memory) libSQL db, self-gated by web-poc's auth middleware. Mirrors
// the injected-db shape the worker uses at the edge (`buildApp` + a libSQL client),
// minus the D1 network hop.

const WORKSPACE = 'ws_edge_test';

const env = {
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long!!',
  BETTER_AUTH_URL: 'http://localhost:8787',
  // Dev escape hatch: `x-dev-workspace` acts as this workspace with full access
  // (no session) — the same seam web-poc's own suites use to exercise `/v1/*`.
  DEV_AUTH_WORKSPACE: WORKSPACE,
} as unknown as Bindings;

const client = createClient({ url: ':memory:' });
const db = makeDb(client);
const app = buildApp({ db });

beforeAll(async () => {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url)),
  });
  await db.insert(schema.workspace).values({ id: WORKSPACE, name: 'Edge Test', slug: 'edge-test' });
});

afterAll(() => client.close());

describe('#56 — Notebook /v1/* at the edge', () => {
  test('unauthenticated /v1 request is session-gated (401 JSON, not an HTML login)', async () => {
    const res = await app.request('/v1/observations', {}, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('a resolved principal reaches /v1/* against the injected db', async () => {
    const res = await app.request(
      '/v1/observations',
      { headers: { 'x-dev-workspace': WORKSPACE } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0 });
  });

  test('create → read round-trips through the injected db (deterministic embed fallback)', async () => {
    const create = await app.request(
      '/v1/observations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dev-workspace': WORKSPACE },
        body: JSON.stringify({ title: 'Edge signal', body: 'Served at the edge' }),
      },
      env,
    );
    expect(create.status).toBe(201);

    const list = await app.request(
      '/v1/observations',
      { headers: { 'x-dev-workspace': WORKSPACE } },
      env,
    );
    const body = (await list.json()) as { total: number };
    expect(body.total).toBe(1);
  });
});
