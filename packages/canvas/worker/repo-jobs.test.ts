import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { discoverJobs, parseJobFile, clearJobsCache } from './repo-jobs.ts';
import type { Env } from './index.ts';

// In-memory DB from the real migrations (mirrors github-connection.test.ts).
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

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  await db.insert(schema.user).values({ id: 'u_j', name: 'u_j', email: 'u_j@example.com' });
  await db.insert(schema.workspaces).values({
    id: 'ws_jobs',
    name: 'jobs-ws',
    ownerUserId: 'u_j',
    githubInstallationId: '777',
    selectedRepos: ['Zabaca/cedarpad', 'Zabaca/empty'],
  });
});

describe('parseJobFile — .claude/jobs/<name>.md frontmatter + body (ADR-0015)', () => {
  test('parses frontmatter fields and keeps the body as the prompt', () => {
    const job = parseJobFile('.claude/jobs/deps-audit.md', [
      '---',
      'name: deps-audit',
      'description: Audit dependency freshness',
      'schedule: daily',
      '---',
      '',
      'Audit the dependencies. Report stale ones.',
    ].join('\n'));
    expect(job).toEqual({
      name: 'deps-audit',
      description: 'Audit dependency freshness',
      schedule: 'daily',
      prompt: 'Audit the dependencies. Report stale ones.',
    });
  });

  test('a file with no frontmatter falls back to its filename, manual schedule, whole-body prompt', () => {
    const job = parseJobFile('.claude/jobs/quick-check.md', 'Just do the thing.');
    expect(job).toEqual({ name: 'quick-check', description: '', schedule: 'manual', prompt: 'Just do the thing.' });
  });

  test('an unknown schedule value degrades to manual (never a surprise auto-run)', () => {
    const job = parseJobFile('.claude/jobs/x.md', '---\nschedule: hourly\n---\nbody');
    expect(job?.schedule).toBe('manual');
  });
});

const APP_ENV = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: TEST_KEY() } as unknown as Env;

function TEST_KEY(): string {
  const { generateKeyPairSync } = require('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

const JOB_MD = '---\nname: deps-audit\ndescription: Audit deps\nschedule: daily\n---\nAudit the dependencies.';

/** GitHub stub: mint, repo lookup, jobs-dir listing, file contents. Counts calls. */
function githubStub() {
  const counts = { mint: 0, dir: 0, file: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/access_tokens')) {
      counts.mint += 1;
      // Read-scoped discovery mint (never write).
      expect(JSON.parse((init?.body as string) ?? '{}').permissions).toEqual({ contents: 'read' });
      return Response.json({ token: 'ghs_read', expires_at: 'x' });
    }
    if (/\/repos\/Zabaca\/cedarpad$/.test(url)) return Response.json({ default_branch: 'main' });
    if (/\/repos\/Zabaca\/empty$/.test(url)) return Response.json({ default_branch: 'main' });
    if (url.includes('/repos/Zabaca/cedarpad/contents/.claude/jobs?ref=main')) {
      counts.dir += 1;
      return Response.json([
        { name: 'deps-audit.md', path: '.claude/jobs/deps-audit.md', sha: 'sha_1', type: 'file' },
        { name: 'README.txt', path: '.claude/jobs/README.txt', sha: 'sha_2', type: 'file' }, // non-md ignored
      ]);
    }
    if (url.includes('/repos/Zabaca/empty/contents/.claude/jobs?ref=main')) {
      counts.dir += 1;
      return new Response('not found', { status: 404 }); // no jobs dir — an empty list, not an error
    }
    if (url.includes('/repos/Zabaca/cedarpad/contents/.claude/jobs/deps-audit.md')) {
      counts.file += 1;
      return Response.json({ content: Buffer.from(JOB_MD).toString('base64'), encoding: 'base64' });
    }
    return new Response('stub 404', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, counts };
}

describe('discoverJobs — the default branch IS the registry (ADR-0015)', () => {
  test('lists parsed jobs across the selected repos; a repo without a jobs dir contributes none', async () => {
    clearJobsCache();
    const { fetchImpl } = githubStub();
    const jobs = await discoverJobs(APP_ENV, database, 'ws_jobs', { nowSec: 1, fetchImpl });
    expect(jobs).toEqual([
      { repo: 'Zabaca/cedarpad', name: 'deps-audit', description: 'Audit deps', schedule: 'daily', prompt: 'Audit the dependencies.' },
    ]);
  });

  test('file contents are cached by blob sha — a re-discover with unchanged shas refetches no files', async () => {
    clearJobsCache();
    const { fetchImpl, counts } = githubStub();
    await discoverJobs(APP_ENV, database, 'ws_jobs', { nowSec: 1, fetchImpl });
    expect(counts.file).toBe(1);
    await discoverJobs(APP_ENV, database, 'ws_jobs', { nowSec: 2, fetchImpl });
    expect(counts.dir).toBe(4); // the listing is always fresh (2 repos × 2 rounds)
    expect(counts.file).toBe(1); // the unchanged blob is not refetched
  });

  test('an unconnected workspace discovers nothing', async () => {
    await db.insert(schema.workspaces).values({ id: 'ws_nogit', name: 'n', ownerUserId: 'u_j' });
    const { fetchImpl } = githubStub();
    expect(await discoverJobs(APP_ENV, database, 'ws_nogit', { nowSec: 1, fetchImpl })).toEqual([]);
  });
});
