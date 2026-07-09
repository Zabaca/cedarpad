import { useState } from 'react';

// The Jobs stage: trigger background-agent runs on demand. A run is fire-and-forget on the edge
// (POST /api/jobs/dev-agent/run → 202) — it wakes the dev-agent container, execs the workflow, and
// surfaces in the Inbox as a session (the unified index). So this stage is purely the TRIGGER;
// observation lives in the Inbox ("All sessions"), and it pings you when it needs a decision.

type RunState = 'idle' | 'starting' | 'started' | 'error';

export function JobsStage() {
  const [state, setState] = useState<RunState>('idle');

  const run = async () => {
    setState('starting');
    const r = await fetch('/api/jobs/dev-agent/run', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    setState(r?.status === 202 ? 'started' : 'error');
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
            Started. It’ll show up in your Inbox under “All sessions,” and ping you when it needs a decision.
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
