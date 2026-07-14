import type { Database } from '../web-poc/lib/db/index.ts';
import { getWorkspaceRecord } from '../web-poc/lib/db/queries/workspaces.ts';
import { mintInstallationToken } from './github-app.ts';
import { workspaceGithub } from './github-connection.ts';
import type { Env } from './index.ts';

// Repo-defined Jobs (#195, ADR-0015): `.claude/jobs/<name>.md` on a selected repo's DEFAULT
// branch — the branch IS the registry (reconcile, don't register). Discovery is pull-based:
// a read-scoped mint + the contents API, no clone, no container. Merge a job → it appears;
// delete the file → it's gone. Nothing here is stored except a blob-sha content cache.
//
// A Job is PR-gated content (the merge is the arming step); the platform wrapper around its
// prompt at run time is bridge code and not opt-out-able (server/bridge.ts).

export type RepoJob = {
  repo: string;
  name: string;
  description: string;
  schedule: 'daily' | 'manual';
  prompt: string;
};

/** Parse one job file: `---` frontmatter (name/description/schedule) + body-as-prompt.
 *  Unknown schedule values degrade to `manual` — a merge must never surprise-schedule. */
export function parseJobFile(path: string, content: string): Omit<RepoJob, 'repo'> | null {
  const filename = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  let body = content;
  const fm: Record<string, string> = {};
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (m) {
    body = content.slice(m[0].length);
    for (const line of (m[1] ?? '').split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (kv) fm[kv[1] as string] = (kv[2] as string).trim();
    }
  }
  const prompt = body.trim();
  if (!prompt) return null;
  return {
    name: fm.name || filename,
    description: fm.description ?? '',
    schedule: fm.schedule === 'daily' ? 'daily' : 'manual',
    prompt,
  };
}

const GH = (token: string) => ({
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cedarpad-dev-agent',
});

// Blob-sha → parsed job. The listing is always fetched fresh (it's 1 call and it IS the
// registry); only unchanged file contents are served from here.
const blobCache = new Map<string, Omit<RepoJob, 'repo'> | null>();
export function clearJobsCache(): void {
  blobCache.clear();
}

async function repoJobs(
  env: Env,
  installationId: string,
  repo: string,
  opts: { nowSec: number; fetchImpl?: typeof fetch },
): Promise<RepoJob[]> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return [];
  const doFetch = opts.fetchImpl ?? fetch;
  const repoName = repo.split('/')[1] ?? repo;
  const { token } = await mintInstallationToken(
    { appId, installationId, privateKey },
    { repositories: [repoName], permissions: { contents: 'read' }, nowSec: opts.nowSec, fetchImpl: opts.fetchImpl },
  );

  const repoRes = await doFetch(`https://api.github.com/repos/${repo}`, { headers: GH(token) });
  if (!repoRes.ok) throw new Error(`repo lookup ${repo}: ${repoRes.status}`);
  const { default_branch } = (await repoRes.json()) as { default_branch: string };

  const dirRes = await doFetch(
    `https://api.github.com/repos/${repo}/contents/.claude/jobs?ref=${encodeURIComponent(default_branch)}`,
    { headers: GH(token) },
  );
  if (dirRes.status === 404) return []; // no jobs dir — this repo defines no jobs
  if (!dirRes.ok) throw new Error(`jobs listing ${repo}: ${dirRes.status}`);
  const entries = (await dirRes.json()) as Array<{ name: string; path: string; sha: string; type: string }>;

  const jobs: RepoJob[] = [];
  for (const e of entries) {
    if (e.type !== 'file' || !e.name.endsWith('.md')) continue;
    let parsed = blobCache.get(e.sha);
    if (parsed === undefined) {
      const fileRes = await doFetch(
        `https://api.github.com/repos/${repo}/contents/${e.path}?ref=${encodeURIComponent(default_branch)}`,
        { headers: GH(token) },
      );
      if (!fileRes.ok) continue;
      const file = (await fileRes.json()) as { content: string };
      parsed = parseJobFile(e.path, Buffer.from(file.content, 'base64').toString('utf8'));
      blobCache.set(e.sha, parsed);
    }
    if (parsed) jobs.push({ repo, ...parsed });
  }
  return jobs;
}

/** Every job defined across the workspace's selected repos. Best-effort per repo: one
 *  unreachable repo degrades to its jobs missing from the list, never a thrown discovery. */
export async function discoverJobs(
  env: Env,
  database: Database,
  workspaceId: string,
  opts: { nowSec: number; fetchImpl?: typeof fetch },
): Promise<RepoJob[]> {
  const ws = await getWorkspaceRecord(database, workspaceId);
  if (!ws) return [];
  const conn = workspaceGithub(env, ws);
  if (!conn.connected) return [];
  const perRepo = await Promise.all(
    conn.selectedRepos.map((repo) =>
      repoJobs(env, conn.installationId, repo, opts).catch((e: unknown) => {
        console.error(`[jobs] discovery failed for ${repo}: ${String(e)}`);
        return [] as RepoJob[];
      }),
    ),
  );
  return perRepo.flat();
}

// ---- The cron evaluator (#196) ------------------------------------------------

// Due = never stamped, or stamped ≥20h ago: tolerant of tick jitter and retried ticks
// (idempotent), while a daily tick can never double-fire a job within its day.
const DAILY_DEBOUNCE_MS = 20 * 3600_000;

/**
 * One tick of the scheduled-jobs evaluator (ADR-0015: reconcile, don't register): discover
 * the workspace's repo jobs fresh, kick every `daily` job that is due per its lastRunAt
 * stamp, stamp on a real start. A JOINED kick (the bridge's one-at-a-time run was already
 * busy) is NOT stamped — the job stays due and retries next tick. Sequential kicks: the
 * bridge single-flights runs anyway; parallel kicks would just join each other.
 */
export async function evaluateScheduledJobs(
  database: Database,
  workspaceId: string,
  deps: {
    nowMs: number;
    discover: () => Promise<RepoJob[]>;
    kick: (repo: string, job: { name: string; prompt: string }) => Promise<Response>;
  },
): Promise<{ kicked: string[] }> {
  const { getJobRunStamp, stampJobRun } = await import('../web-poc/lib/db/queries/job-stamps.ts');
  const kicked: string[] = [];
  const jobs = await deps.discover();
  for (const job of jobs) {
    if (job.schedule !== 'daily') continue;
    const key = { workspaceId, repo: job.repo, job: job.name };
    const last = await getJobRunStamp(database, key);
    if (last && deps.nowMs - last.getTime() < DAILY_DEBOUNCE_MS) continue;
    try {
      const res = await deps.kick(job.repo, { name: job.name, prompt: job.prompt });
      const body = res.status === 202 ? ((await res.json().catch(() => null)) as { joined?: boolean } | null) : null;
      if (body && !body.joined) {
        await stampJobRun(database, { ...key, nowMs: deps.nowMs });
        kicked.push(`${job.repo}#${job.name}`);
      } else if (body?.joined) {
        console.log(`[jobs] ${job.repo}#${job.name} due but a run is in flight — retrying next tick`);
      } else {
        console.error(`[jobs] scheduled kick failed for ${job.repo}#${job.name}: ${res.status}`);
      }
    } catch (e: unknown) {
      console.error(`[jobs] scheduled kick threw for ${job.repo}#${job.name}: ${String(e)}`);
    }
  }
  return { kicked };
}
