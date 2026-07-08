// Register happy-dom's window/document BEFORE importing the component tree (shared with
// the canvas app's tests — it preserves Bun's native fetch/Response, which we stub below).
import '../../src/happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React's `act` only flushes effects when this flag is set (we're a test renderer).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Shell } from './Shell';

const WORKSPACES = { workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws_abc', name: 'Zabaca' }] };
const CANVASES = { workspaceId: 'ws_abc', canvases: [{ id: 'cv_1', name: 'Roadmap' }] };

const realFetch = globalThis.fetch;
let calls: string[] = [];

/** The two edge APIs the shell talks to. Everything else 404s so a stray call is visible. */
function stubEdge() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/workspaces') return Response.json(WORKSPACES);
    if (url === '/api/canvases') return Response.json(CANVASES);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let container: HTMLDivElement;
let root: Root;

async function mountShell() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Shell />);
  });
}

const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const byTitle = (title: string) => container.querySelector(`[title="${title}"]`);

beforeEach(async () => {
  calls = [];
  stubEdge();
  // Give the document a real origin so pushState (relative URL) resolves under happy-dom,
  // whose default document is about:blank (origin null).
  (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL('https://poc.cedarpad.com/');
  window.history.replaceState(null, '', '/');
  await mountShell();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

// The rail is the ONE chrome (PRD #103). Switching stages is inline — no navigation — and
// the choice is reflected in the URL.
describe('the rail switches stages and reflects the choice in the URL', () => {
  test('the canvas stage is the default', () => {
    expect(container.querySelector('.stage-canvas')).not.toBeNull();
    expect(window.location.search).toBe('');
  });

  test('Notebook and Inbox are inline stages, not navigations', async () => {
    await click(byTitle('Notebook'));
    expect(container.querySelector('.stage-notebook')).not.toBeNull();
    expect(container.querySelector('.stage-canvas')).toBeNull();
    expect(window.location.search).toBe('?stage=notebook');

    await click(byTitle('Inbox'));
    expect(container.querySelector('.stage-inbox')).not.toBeNull();
    expect(window.location.search).toBe('?stage=inbox');

    await click(byTitle('Canvases'));
    expect(container.querySelector('.stage-canvas')).not.toBeNull();
    expect(window.location.search).toBe('');
  });
});

// The canvas selector: the same edge-API-only list the container's LeftPanel used to own.
describe('the canvas stage', () => {
  test('lists the workspace’s canvases from /api/canvases, with the legacy Default first', () => {
    expect(calls).toContain('GET /api/canvases');
    const names = [...container.querySelectorAll('.page-name')].map((n) => n.textContent);
    expect(names).toEqual(['Default', 'Roadmap']);
  });

  test('nothing is mounted until a canvas is picked — browsing the shell must not wake the container', () => {
    expect(container.querySelector('iframe')).toBeNull();
  });

  test('picking a canvas mounts the pad in a same-origin iframe at its own URL', async () => {
    await click([...container.querySelectorAll('.page-row')][1] ?? null);

    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toBe('/w/ws_abc/canvas/cv_1/pad');
    // Same-origin, so the Better Auth cookie flows and chat stays inside the pad: no sandbox.
    expect(frame?.getAttribute('sandbox')).toBeNull();
  });

  test('the legacy Default canvas resolves to the default pad URL', async () => {
    await click([...container.querySelectorAll('.page-row')][0] ?? null);

    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/w/ws_abc/canvas/default/pad');
  });
});

// The Z button's workspace list is now backed by the edge registry, replacing the
// hardcoded `WORKSPACE_NAME = 'Zabaca'` the container's LeftPanel carried.
describe('the workspace popover is backed by /api/workspaces', () => {
  test('opening it lists the owner’s workspaces and marks the active one', async () => {
    expect(calls).not.toContain('GET /api/workspaces'); // not fetched until opened

    await click(container.querySelector('.lp-z'));

    expect(calls).toContain('GET /api/workspaces');
    const rows = [...container.querySelectorAll('.lp-ws-row')];
    expect(rows.map((r) => r.querySelector('.lp-ws-name')?.textContent)).toEqual(['Default', 'Zabaca']);
    // /api/canvases reported ws_abc as the active scope.
    expect(rows[1]?.className).toContain('active');
  });
});

describe('the avatar signs out through the edge Better Auth endpoint', () => {
  test('Sign out POSTs /api/auth/sign-out', async () => {
    await click(byTitle('Account'));
    await click(container.querySelector('.lp-signout'));

    expect(calls).toContain('POST /api/auth/sign-out');
  });
});
