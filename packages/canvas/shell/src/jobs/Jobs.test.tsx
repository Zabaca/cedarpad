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

beforeEach(() => {
  calls = [];
  nextStatus = 202;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(null, { status: nextStatus });
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
});
