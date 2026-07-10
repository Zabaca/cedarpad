import { useState } from 'react';

// The Jobs stage: trigger background-agent runs on demand. A run is a headless chat turn on the
// warm bridge (ADR-0011): POST /api/jobs/dev-agent/run → the edge mints the per-turn git token
// and proxies the kick → 202 { chatId, joined }. The session appears in the Inbox ("All
// sessions") the moment it starts (row-at-start) and streams live when opened — this stage is
// purely the TRIGGER. joined:true = a run was already in flight and the kick joined it.

type RunState = 'idle' | 'starting' | 'started' | 'joined' | 'error';

export function JobsStage() {
  const [state, setState] = useState<RunState>('idle');

  const run = async () => {
    setState('starting');
    const r = await fetch('/api/jobs/dev-agent/run', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    if (r?.status !== 202) return setState('error');
    const body = (await r.json().catch(() => null)) as { joined?: boolean } | null;
    setState(body?.joined ? 'joined' : 'started');
  };

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
          <button type="button" className="jobs-run" onClick={run} disabled={state === 'starting'}>
            {state === 'starting' ? 'Starting…' : 'Run now'}
          </button>
        </div>
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
