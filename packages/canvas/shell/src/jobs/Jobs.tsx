import { useEffect, useState } from 'react';

// The Jobs stage: trigger background-agent runs on demand. A run is a headless chat turn on the
// warm bridge (ADR-0011): POST /api/jobs/dev-agent/run → the edge resolves the workspace's repo
// (ADR-0015), mints the per-turn git token and proxies the kick → 202 { chatId, joined }. The
// session appears in the Inbox ("All sessions") the moment it starts (row-at-start) and streams
// live when opened — this stage is purely the TRIGGER. joined:true = a run was already in flight
// and the kick joined it.
//
// Repo picker (ADR-0015): a platform job is repo-agnostic, so its target is chosen at trigger.
// One selected repo ⇒ the server defaults to it, no picker; several ⇒ pick here, the choice
// rides the POST body. Runs kick on the default workspace's container, so its connection
// (`/api/workspaces/default/github`) names the selectable set.

type RunState = 'idle' | 'starting' | 'started' | 'joined' | 'error';
type RepoJobView = { repo: string; name: string; description: string; schedule: string };

export function JobsStage() {
  const [state, setState] = useState<RunState>('idle');
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [repoJobs, setRepoJobs] = useState<RepoJobView[]>([]);

  useEffect(() => {
    void (async () => {
      const r = await fetch('/api/workspaces/default/github', { credentials: 'same-origin' }).catch(() => null);
      if (r?.ok) {
        const d = (await r.json()) as { selectedRepos?: string[] };
        setRepos(d.selectedRepos ?? []);
      }
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

  const run = () => kick(repos.length > 1 && repo ? { repo } : {});

  return (
    <div className="shell-stage stage-jobs">
      <div className="jobs-list">
        <h2 className="jobs-title">Jobs</h2>
        <div className="jobs-card">
          <div className="jobs-card-main">
            <b>Architecture explore</b>
            <span className="jobs-card-sub">
              The dev-agent explores the codebase, proposes improvements, and asks you to pick one.
            </span>
          </div>
          {repos.length > 1 && (
            <select
              className="jobs-repo-picker"
              value={repo ?? repos[0]}
              onChange={(e) => setRepo(e.target.value)}
              title="The repo this run targets"
            >
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="jobs-run" onClick={run} disabled={state === 'starting'}>
            {state === 'starting' ? 'Starting…' : 'Run now'}
          </button>
        </div>
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
