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
// the 202/failure back to the operator.

const realFetch = globalThis.fetch;
let container: HTMLElement;
let root: Root;
let calls: string[] = [];
let nextStatus = 202;

let nextBody: Record<string, unknown> = { chatId: 'dev-agent-run-1', joined: false };
let selectedRepos: string[] = ['Zabaca/cedarpad'];
let runBodies: unknown[] = [];

beforeEach(() => {
  calls = [];
  nextStatus = 202;
  nextBody = { chatId: 'dev-agent-run-1', joined: false };
  selectedRepos = ['Zabaca/cedarpad'];
  runBodies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input) === '/api/workspaces/default/github') {
      return Response.json({ connected: true, source: 'workspace', selectedRepos });
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

  // ADR-0015: a platform job picks its target at trigger. One selected repo ⇒ no picker
  // (the server defaults); several ⇒ the picker names the run's repo in the POST body.
  test('a single selected repo shows no picker and POSTs no repo', async () => {
    await mount();
    await clickRun();

    expect(container.querySelector('.jobs-repo-picker')).toBeNull();
    expect(runBodies).toEqual([{}]);
  });

  test('multiple selected repos render the picker; the chosen repo rides the POST body', async () => {
    selectedRepos = ['Zabaca/cedarpad', 'Zabaca/ledgerbot'];
    await mount();

    const picker = container.querySelector('.jobs-repo-picker') as HTMLSelectElement | null;
    expect(picker).not.toBeNull();
    await act(async () => {
      picker!.value = 'Zabaca/ledgerbot';
      picker!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickRun();

    expect(runBodies).toEqual([{ repo: 'Zabaca/ledgerbot' }]);
  });
});
