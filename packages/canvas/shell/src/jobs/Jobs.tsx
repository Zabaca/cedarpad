import { useEffect, useState } from 'react';

// The Jobs stage: trigger background-agent runs on demand. A run is a headless chat turn on the
// warm bridge (ADR-0011): POST /api/jobs/dev-agent/run → the edge resolves the workspace's repo
// (ADR-0015), mints the per-turn git token and proxies the kick → 202 { chatId, joined }. The
// session appears in the Inbox ("All sessions") the moment it starts (row-at-start) and streams
// live when opened — this stage is purely the TRIGGER. joined:true = a run was already in flight
// and the kick joined it.
//
// Every card is a repo-defined job (#100 / ADR-0015): `.claude/jobs/<name>.md` on a selected
// repo's default branch. There is no built-in job — a run always names one, and each job runs
// against its home repo, so there is nothing to pick but the job.

type RunState = 'idle' | 'starting' | 'started' | 'joined' | 'error';
type RepoJobView = { repo: string; name: string; description: string; schedule: string };

export function JobsStage() {
  const [state, setState] = useState<RunState>('idle');
  const [repoJobs, setRepoJobs] = useState<RepoJobView[]>([]);

  useEffect(() => {
    void (async () => {
      // Repo-defined jobs (#195): whatever the selected repos' default branches define.
      const j = await fetch('/api/workspaces/default/jobs', { credentials: 'same-origin' }).catch(() => null);
      if (j?.ok) {
        const d = (await j.json()) as { jobs?: RepoJobView[] };
        setRepoJobs(d.jobs ?? []);
      }
    })();
  }, []);

  const kick = async (body: Record<string, string>) => {
    setState('starting');
    const r = await fetch('/api/jobs/dev-agent/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.status !== 202) return setState('error');
    const resBody = (await r.json().catch(() => null)) as { joined?: boolean } | null;
    setState(resBody?.joined ? 'joined' : 'started');
  };

  return (
    <div className="shell-stage stage-jobs">
      <div className="jobs-list">
        <h2 className="jobs-title">Jobs</h2>
        {repoJobs.map((j) => (
          <div key={`${j.repo}:${j.name}`} className="jobs-card">
            <div className="jobs-card-main">
              <b>{j.name}</b>
              <span className="jobs-card-sub">
                {j.repo} · {j.schedule}
                {j.description ? ` — ${j.description}` : ''}
              </span>
            </div>
            <button
              type="button"
              className="jobs-run"
              onClick={() => void kick({ repo: j.repo, job: j.name })}
              disabled={state === 'starting'}
            >
              {state === 'starting' ? 'Starting…' : 'Run now'}
            </button>
          </div>
        ))}
        {repoJobs.length === 0 && (
          <div className="jobs-note" role="status">
            No jobs yet. A job is a <code>.claude/jobs/&lt;name&gt;.md</code> file on a selected repo’s default branch —
            merge one and it appears here.
          </div>
        )}
        {state === 'started' && (
          <div className="jobs-note" role="status">
            Started. It’s in your Inbox under “All sessions” — open it to watch live; it’ll ping you when it needs a decision.
          </div>
        )}
        {state === 'joined' && (
          <div className="jobs-note" role="status">
            Already running — the current run is in your Inbox under “All sessions.”
          </div>
        )}
        {state === 'error' && (
          <div className="jobs-note jobs-error" role="status">
            Couldn’t start the run. Try again.
          </div>
        )}
      </div>
    </div>
  );
}
