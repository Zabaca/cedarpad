// happy-dom's window/document must register BEFORE the component tree imports (same as the other
// shell tests).
import '../../../src/happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { JobsStage } from './Jobs';

// The Jobs stage is the TRIGGER surface: "Run now" POSTs /api/jobs/dev-agent/run (fire-and-forget;
// the run then appears in the Inbox). These pin that the button dispatches the trigger and reflects
// the 202/failure back to the operator. #100: every card is a repo-defined job — there is no
// built-in card and no repo picker, so a run always names a job and its home repo.

const realFetch = globalThis.fetch;
let container: HTMLElement;
let root: Root;
let calls: string[] = [];
let nextStatus = 202;

let nextBody: Record<string, unknown> = { chatId: 'dev-agent-run-1', joined: false };
let repoJobs: unknown[] = [{ repo: 'Zabaca/cedarpad', name: 'deps-audit', description: 'Audit deps', schedule: 'daily' }];
let runBodies: unknown[] = [];

beforeEach(() => {
  calls = [];
  nextStatus = 202;
  nextBody = { chatId: 'dev-agent-run-1', joined: false };
  repoJobs = [{ repo: 'Zabaca/cedarpad', name: 'deps-audit', description: 'Audit deps', schedule: 'daily' }];
  runBodies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input) === '/api/workspaces/default/jobs') {
      return Response.json({ jobs: repoJobs });
    }
    if (init?.body) runBodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(nextBody), { status: nextStatus, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const mount = async () => {
  await act(async () => root.render(<JobsStage />));
};
const runBtn = () => container.querySelector('.jobs-run') as HTMLButtonElement | null;
const clickRun = async () => {
  await act(async () => runBtn()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('JobsStage', () => {
  test('Run now POSTs /api/jobs/dev-agent/run and confirms on 202', async () => {
    await mount();
    await clickRun();

    expect(calls).toContain('POST /api/jobs/dev-agent/run');
    // #100: the kick always names a job and its home repo — never a jobless default run.
    expect(runBodies).toEqual([{ repo: 'Zabaca/cedarpad', job: 'deps-audit' }]);
    expect(container.querySelector('.jobs-note')?.textContent).toContain('Inbox');
    expect(container.querySelector('.jobs-error')).toBeNull();
  });

  test('a non-202 surfaces an error, not a false "started"', async () => {
    nextStatus = 500;
    await mount();
    await clickRun();

    expect(container.querySelector('.jobs-error')).not.toBeNull();
  });

  // ADR-0011 join semantics: a kick during a running run answers with THAT run (joined:true) —
  // "Run now" while running means "it's already going", not a second explore.
  test('joined:true reads as "already running", not as a fresh start', async () => {
    nextBody = { chatId: 'dev-agent-run-live', joined: true };
    await mount();
    await clickRun();

    expect(container.querySelector('.jobs-note')?.textContent).toContain('Already running');
    expect(container.querySelector('.jobs-error')).toBeNull();
  });

  // #100: the repo picker is gone with the built-in job — a job runs against its home repo.
  test('no repo picker: the job card carries its own repo', async () => {
    await mount();

    expect(container.querySelector('.jobs-repo-picker')).toBeNull();
    expect(calls).not.toContain('GET /api/workspaces/default/github');
  });

  // #195: repo-defined jobs render as their own cards; Run names the job — the edge re-reads
  // its body off the default branch (the card is a trigger, never a prompt channel).
  test('discovered repo jobs render as cards and Run POSTs the job name + home repo', async () => {
    repoJobs = [
      { repo: 'Zabaca/cedarpad', name: 'deps-audit', description: 'Audit deps', schedule: 'daily' },
      { repo: 'Zabaca/other', name: 'nightly', description: '', schedule: 'manual' },
    ];
    await mount();

    const cards = [...container.querySelectorAll('.jobs-card')];
    expect(cards.length).toBe(2); // ONLY the discovered jobs — no built-in card (#100)
    expect(container.textContent).toContain('deps-audit');
    expect(container.textContent).toContain('Zabaca/cedarpad');
    expect(container.textContent).toContain('daily');

    const btn = cards[1]?.querySelector('.jobs-run') as HTMLButtonElement;
    await act(async () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(runBodies).toEqual([{ repo: 'Zabaca/other', job: 'nightly' }]);
  });

  // With the built-in card gone, a workspace whose repos define no jobs has nothing to run —
  // say where jobs come from rather than rendering an empty stage.
  test('no discovered jobs ⇒ an empty state naming .claude/jobs/', async () => {
    repoJobs = [];
    await mount();

    expect(container.querySelector('.jobs-card')).toBeNull();
    expect(container.querySelector('.jobs-note')?.textContent).toContain('.claude/jobs/');
  });
});
