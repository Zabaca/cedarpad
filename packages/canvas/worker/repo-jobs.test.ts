import { migrationStatements } from './migration-statements.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { discoverJobs, parseJobFile, clearJobsCache } from './repo-jobs.ts';
import type { Env } from './index.ts';

// In-memory DB from the real migrations (mirrors github-connection.test.ts).
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
      target: 'agent',
      prompt: 'Audit the dependencies. Report stale ones.',
    });
  });

  test('a file with no frontmatter falls back to its filename, manual schedule, agent target, whole-body prompt', () => {
    const job = parseJobFile('.claude/jobs/quick-check.md', 'Just do the thing.');
    expect(job).toEqual({ name: 'quick-check', description: '', schedule: 'manual', target: 'agent', prompt: 'Just do the thing.' });
  });

  test('an unknown schedule value degrades to manual (never a surprise auto-run)', () => {
    const job = parseJobFile('.claude/jobs/x.md', '---\nschedule: hourly\n---\nbody');
    expect(job?.schedule).toBe('manual');
  });

  test('target: warehouse opts a job into materialize dispatch (#240)', () => {
    const job = parseJobFile('.claude/jobs/materialize-mart.md', '---\nschedule: daily\ntarget: warehouse\n---\nMaterialize the mart.');
    expect(job?.target).toBe('warehouse');
  });

  test('an unknown/absent target degrades to agent — a merge can never silently start dispatching to the warehouse', () => {
    expect(parseJobFile('.claude/jobs/a.md', 'body')?.target).toBe('agent');
    expect(parseJobFile('.claude/jobs/b.md', '---\ntarget: dbt-cloud\n---\nbody')?.target).toBe('agent');
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
      { repo: 'Zabaca/cedarpad', name: 'deps-audit', description: 'Audit deps', schedule: 'daily', target: 'agent', prompt: 'Audit the dependencies.' },
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

  test('PAT repos participate in discovery uniformly (ADR-0016), authed by the opened PAT', async () => {
    clearJobsCache();
    const { sealSecret } = await import('./secret-box.ts');
    await db.insert(schema.workspaces).values({ id: 'ws_pat', name: 'p', ownerUserId: 'u_j' });
    await db.insert(schema.workspaceRepos).values({
      id: 'wr_pat_jobs',
      workspaceId: 'ws_pat',
      fullName: 'hudsonts/app',
      source: 'pat',
      encryptedToken: await sealSecret('k', 'github_pat_x'),
    });
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(`${new Headers(init?.headers).get('authorization')} ${url}`);
      if (/\/repos\/hudsonts\/app$/.test(url)) return Response.json({ default_branch: 'main' });
      if (url.includes('/repos/hudsonts/app/contents/.claude/jobs?ref=main')) {
        return Response.json([{ name: 'triage.md', path: '.claude/jobs/triage.md', sha: 'sha_p', type: 'file' }]);
      }
      if (url.includes('/repos/hudsonts/app/contents/.claude/jobs/triage.md')) {
        return Response.json({ content: Buffer.from('Triage the queue.').toString('base64'), encoding: 'base64' });
      }
      return new Response('stub 404', { status: 404 });
    }) as typeof fetch;

    const jobs = await discoverJobs({ REPO_TOKEN_KEY: 'k' } as Env, database, 'ws_pat', { nowSec: 1, fetchImpl });
    expect(jobs).toEqual([
      { repo: 'hudsonts/app', name: 'triage', description: '', schedule: 'manual', target: 'agent', prompt: 'Triage the queue.' },
    ]);
    // Every call authed by the opened PAT — no App mint anywhere.
    expect(seen.every((s) => s.startsWith('token github_pat_x '))).toBe(true);
  });

  test('an unconnected workspace discovers nothing', async () => {
    await db.insert(schema.workspaces).values({ id: 'ws_nogit', name: 'n', ownerUserId: 'u_j' });
    const { fetchImpl } = githubStub();
    expect(await discoverJobs(APP_ENV, database, 'ws_nogit', { nowSec: 1, fetchImpl })).toEqual([]);
  });

  // Selectivity (#240 req 3): a job must never auto-run against every attached repo — only
  // the workspace's SELECTED repos. `Zabaca/unselected` here has a real `.claude/jobs/`
  // file, reachable by the same GitHub API a selected repo would use, but is not in
  // `ws_jobs`'s selectedRepos — proving discoverJobs (and therefore evaluateScheduledJobs,
  // which only ever dispatches what discoverJobs returns) never surfaces its job.
  test('a job file on an UNSELECTED repo is never discovered, even if reachable via the same App installation', async () => {
    clearJobsCache();
    const { fetchImpl: base } = githubStub();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/repos\/Zabaca\/unselected$/.test(url)) return Response.json({ default_branch: 'main' });
      if (url.includes('/repos/Zabaca/unselected/contents/.claude/jobs?ref=main')) {
        return Response.json([{ name: 'sneaky.md', path: '.claude/jobs/sneaky.md', sha: 'sha_sneaky', type: 'file' }]);
      }
      if (url.includes('/repos/Zabaca/unselected/contents/.claude/jobs/sneaky.md')) {
        return Response.json({ content: Buffer.from('---\nschedule: daily\n---\nDo the sneaky thing.').toString('base64'), encoding: 'base64' });
      }
      return base(input, init);
    }) as typeof fetch;
    const jobs = await discoverJobs(APP_ENV, database, 'ws_jobs', { nowSec: 1, fetchImpl });
    expect(jobs.some((j) => j.repo === 'Zabaca/unselected')).toBe(false);
    expect(jobs).toEqual([
      { repo: 'Zabaca/cedarpad', name: 'deps-audit', description: 'Audit deps', schedule: 'daily', target: 'agent', prompt: 'Audit the dependencies.' },
    ]);
  });
});

// ---- The cron evaluator (#196): tick → discover → due-check → kick → stamp ----

import { evaluateScheduledJobs } from './repo-jobs.ts';

describe('evaluateScheduledJobs — the tick is an evaluator, not a registry', () => {
  const DAY = 24 * 3600_000;
  const jobs = (over: Partial<{ schedule: 'daily' | 'manual'; target: 'agent' | 'warehouse' }> = {}) => [
    { repo: 'Zabaca/cedarpad', name: 'deps-audit', description: '', schedule: 'daily' as const, target: 'agent' as const, prompt: 'Audit.', ...over },
  ];

  const kickRecorder = (joined = false) => {
    const kicks: Array<{ repo: string; job: string; target: 'agent' | 'warehouse' }> = [];
    const kick = async (repo: string, job: { name: string; prompt: string; target: 'agent' | 'warehouse' }) => {
      kicks.push({ repo, job: job.name, target: job.target });
      return Response.json({ chatId: 'run-x', joined }, { status: 202 });
    };
    return { kicks, kick };
  };

  test('a never-run daily job is due: kicked once, stamped, and NOT re-kicked the same day', async () => {
    const { kicks, kick } = kickRecorder();
    const r1 = await evaluateScheduledJobs(database, 'ws_jobs', { nowMs: DAY * 100, discover: async () => jobs(), kick });
    expect(r1.kicked).toEqual(['Zabaca/cedarpad#deps-audit']);
    // same tick retried an hour later — debounced by the stamp
    const r2 = await evaluateScheduledJobs(database, 'ws_jobs', { nowMs: DAY * 100 + 3600_000, discover: async () => jobs(), kick });
    expect(r2.kicked).toEqual([]);
    // the next day it is due again
    const r3 = await evaluateScheduledJobs(database, 'ws_jobs', { nowMs: DAY * 101, discover: async () => jobs(), kick });
    expect(r3.kicked).toEqual(['Zabaca/cedarpad#deps-audit']);
    expect(kicks.length).toBe(2);
  });

  test('manual jobs are never auto-kicked', async () => {
    const { kicks, kick } = kickRecorder();
    await evaluateScheduledJobs(database, 'ws_jobs', { nowMs: DAY * 200, discover: async () => jobs({ schedule: 'manual' }), kick });
    expect(kicks).toEqual([]);
  });

  // #240: the evaluator forwards `target` untouched to `kick` — the branch between the
  // canvas container and the Warehouse container is the CALLER's (worker/index.ts), not
  // this evaluator's, but it can only branch correctly if the target rides along.
  test('a due warehouse-target job is kicked with target: warehouse, not silently treated as agent', async () => {
    const { kicks, kick } = kickRecorder();
    await evaluateScheduledJobs(database, 'ws_jobs', {
      nowMs: DAY * 400,
      discover: async () => jobs({ target: 'warehouse' }),
      kick,
    });
    expect(kicks).toEqual([{ repo: 'Zabaca/cedarpad', job: 'deps-audit', target: 'warehouse' }]);
  });

  test('a JOINED kick (another run in flight) does NOT stamp — the job retries next tick', async () => {
    const { kick } = kickRecorder(true);
    const r1 = await evaluateScheduledJobs(database, 'ws_stamp2', { nowMs: DAY * 300, discover: async () => jobs(), kick });
    expect(r1.kicked).toEqual([]); // joined ⇒ not counted as this job's run
    const fresh = kickRecorder(false);
    const r2 = await evaluateScheduledJobs(database, 'ws_stamp2', { nowMs: DAY * 300 + 3600_000, discover: async () => jobs(), kick: fresh.kick });
    expect(r2.kicked).toEqual(['Zabaca/cedarpad#deps-audit']); // still due — never stamped
  });
});
