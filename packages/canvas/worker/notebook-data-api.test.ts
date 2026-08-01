import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { makeDb, schema } from '../web-poc/lib/db/index.ts';
import { DataSourceSchema } from '../shared/mart-contract.ts';
import { handleNotebookApi } from './notebook-data-api.ts';

// A canvas reads the Notebook live (ADR-0024 + ADR-0017's "a component names a source,
// never a URL"). Every fact below is established through the same seam a caller uses:
// the contract (`DataSourceSchema`) and the edge resolver (`handleNotebookApi`).

const WS = 'ws_notebook_source';
const OTHER_WS = 'ws_other';

const client = createClient({ url: ':memory:' });
const db = makeDb(client);

const rowsOf = async (res: Response) => ((await res.json()) as { rows: Record<string, unknown>[] }).rows;

beforeAll(async () => {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url)),
  });
});

afterAll(() => client.close());

describe('the notebook data source contract', () => {
  test('a notebook source with a known query and its params parses', () => {
    const parsed = DataSourceSchema.parse({ kind: 'notebook', query: 'problem_observations', params: { problemId: 'p1' } });
    expect(parsed).toEqual({ kind: 'notebook', query: 'problem_observations', params: { problemId: 'p1' } });
  });

  test('the mart source still parses unchanged', () => {
    expect(DataSourceSchema.parse({ kind: 'mart', name: 'mart_runway' })).toEqual({ kind: 'mart', name: 'mart_runway' });
  });

  test('an unknown query name is refused at the contract', () => {
    expect(DataSourceSchema.safeParse({ kind: 'notebook', query: 'drop_everything' }).success).toBe(false);
  });

  test('free-form SQL cannot be smuggled in as a source', () => {
    expect(DataSourceSchema.safeParse({ kind: 'notebook', sql: 'select * from observations' }).success).toBe(false);
  });
});

describe('handleNotebookApi', () => {
  beforeAll(async () => {
    const t = (ms: number) => new Date(ms);
    await db.insert(schema.sources).values([
      { id: 'src_call', workspaceId: WS, kind: 'call', identifier: 'call-1', label: 'Kickoff call' },
      { id: 'src_url', workspaceId: WS, kind: 'url', identifier: 'https://example.com' },
    ]);
    await db.insert(schema.problems).values([
      { id: 'prob_low', workspaceId: WS, title: 'Low priority', body: 'b', priority: 1, status: 'open', createdAt: t(1_000), updatedAt: t(1_000) },
      { id: 'prob_high', workspaceId: WS, title: 'High priority', body: 'b', priority: 9, status: 'open', urgency: 'critical', createdAt: t(2_000), updatedAt: t(2_000) },
      { id: 'prob_done', workspaceId: WS, title: 'Resolved', body: 'b', priority: 99, status: 'resolved', createdAt: t(3_000), updatedAt: t(3_000) },
      { id: 'prob_other_ws', workspaceId: OTHER_WS, title: 'Someone else', body: 'b', priority: 50, status: 'open', createdAt: t(4_000), updatedAt: t(4_000) },
    ]);
    await db.insert(schema.observations).values([
      { id: 'obs_call', workspaceId: WS, title: 'From the call', body: 'b', origin: 'agent', sourceId: 'src_call', createdAt: t(1_000), updatedAt: t(1_000) },
      { id: 'obs_url', workspaceId: WS, title: 'From the page', body: 'b', sourceId: 'src_url', createdAt: t(2_000), updatedAt: t(2_000) },
      { id: 'obs_other_ws', workspaceId: OTHER_WS, title: 'Not yours', body: 'b', createdAt: t(3_000), updatedAt: t(3_000) },
    ]);
    await db.insert(schema.observationProblems).values([{ observationId: 'obs_call', problemId: 'prob_high' }]);
  });

  const member = { kind: 'member' } as const;

  test('open_problems returns the workspace\'s open problems, highest priority first', async () => {
    const res = await handleNotebookApi(db, WS, 'open_problems', {}, member);
    expect(res.status).toBe(200);
    const rows = await rowsOf(res);
    expect(rows.map((r) => r.id)).toEqual(['prob_high', 'prob_low']);
    expect(rows[0]).toMatchObject({ title: 'High priority', priority: 9, urgency: 'critical', status: 'open' });
  });

  test('open_problems honours its limit param', async () => {
    const rows = await rowsOf(await handleNotebookApi(db, WS, 'open_problems', { limit: '1' }, member));
    expect(rows.map((r) => r.id)).toEqual(['prob_high']);
  });

  test('problem_observations returns the observations feeding one problem', async () => {
    const rows = await rowsOf(await handleNotebookApi(db, WS, 'problem_observations', { problemId: 'prob_high' }, member));
    expect(rows.map((r) => r.id)).toEqual(['obs_call']);
    expect(rows[0]).toMatchObject({ title: 'From the call', origin: 'agent', source_label: 'Kickoff call', source_kind: 'call' });
  });

  test('problem_observations without its required param is a 400', async () => {
    const res = await handleNotebookApi(db, WS, 'problem_observations', {}, member);
    expect(res.status).toBe(400);
  });

  test('recent_observations returns newest first, and narrows to one source when asked', async () => {
    const all = await rowsOf(await handleNotebookApi(db, WS, 'recent_observations', {}, member));
    expect(all.map((r) => r.id)).toEqual(['obs_url', 'obs_call']);
    const bySource = await rowsOf(await handleNotebookApi(db, WS, 'recent_observations', { sourceId: 'src_call' }, member));
    expect(bySource.map((r) => r.id)).toEqual(['obs_call']);
  });

  test('rows are workspace-scoped — another workspace\'s records never appear', async () => {
    const problems = await rowsOf(await handleNotebookApi(db, WS, 'open_problems', {}, member));
    const observations = await rowsOf(await handleNotebookApi(db, WS, 'recent_observations', {}, member));
    expect([...problems, ...observations].map((r) => r.id)).not.toContain('prob_other_ws');
    expect(observations.map((r) => r.id)).not.toContain('obs_other_ws');
  });

  test('an observation recorded seconds ago is already readable — no materialization step', async () => {
    await db.insert(schema.observations).values({ id: 'obs_fresh', workspaceId: WS, title: 'Just now', body: 'b', createdAt: new Date(9_000), updatedAt: new Date(9_000) });
    const rows = await rowsOf(await handleNotebookApi(db, WS, 'recent_observations', {}, member));
    expect(rows[0]).toMatchObject({ id: 'obs_fresh', title: 'Just now' });
  });

  test('an unknown query name is refused at the route, with no SQL run', async () => {
    const res = await handleNotebookApi(db, WS, 'observations; drop table observations', {}, member);
    expect(res.status).toBe(404);
  });

  test('a share-link guest reads nothing from the Notebook', async () => {
    const res = await handleNotebookApi(db, WS, 'open_problems', {}, { kind: 'guest' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
