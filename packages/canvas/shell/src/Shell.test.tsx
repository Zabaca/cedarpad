// Register happy-dom's window/document BEFORE importing the component tree (shared with
// the canvas app's tests — it preserves Bun's native fetch/Response, which we stub below).
import '../../src/happydom-harness.ts';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React's `act` only flushes effects when this flag is set (we're a test renderer).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Shell } from './Shell';
import { useAppStore } from '../../web-poc/src/store.js';

// The Notebook stage (slice #107) mounts web-poc's real `openapi-fetch` client, which builds
// relative request URLs (`config.apiUrl` is `""`). A real browser resolves those against
// `document.baseURI`; Bun's native `Request` has no such implicit base and throws on a bare
// `/v1/...` string. Patch it to resolve against an origin, the way the browser would — this
// is a test-environment gap only, nothing in application code changes.
const RealRequest = globalThis.Request;
class OriginAwareRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) {
      super(`https://poc.cedarpad.com${input}`, init);
    } else {
      super(input as never, init);
    }
  }
}
globalThis.Request = OriginAwareRequest as unknown as typeof Request;
// bun:test runs all files in one process — restore the native Request after this file's
// tests finish so the patch can't leak into unrelated test files that run after it.
afterAll(() => {
  globalThis.Request = RealRequest;
});

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
    // Better Auth's session check, so the lazily-mounted Notebook (slice #107) renders its
    // authenticated view instead of <AuthScreen/> — the Shell itself already sits behind
    // the edge auth gate, so under the Shell this always resolves.
    if (url.endsWith('/api/auth/get-session')) {
      return Response.json({ session: { id: 'sess_1' }, user: { id: 'u_1', email: 'demo@example.com' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** Poll a condition inside `act` so pending microtasks (lazy import, queries) get to run. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
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
  // web-poc's zustand store is a module singleton, so a mutation in one test (e.g.
  // switching Notebook's sub-nav to "Knowledge Graph") would otherwise leak into the next
  // test's fresh Shell mount.
  useAppStore.setState({
    view: 'library',
    selectedProblemId: null,
    selectedObservationId: null,
    selectedKind: null,
    scopeWorkspaceId: null,
    synthPicks: [],
  });
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

// The selected canvas is URL-persisted (mirrors stage.ts / inbox-url.ts): a reload lands
// back on the same open canvas, though the camera/zoom inside the pad already did.
describe('the selected canvas persists in the URL', () => {
  test('picking a canvas sets ?canvas=<id> (replaceState, no history entry)', async () => {
    await click([...container.querySelectorAll('.page-row')][1] ?? null);

    expect(window.location.search).toBe('?canvas=cv_1');
  });

  test('a reload with ?canvas=<id> in the URL reopens that canvas', async () => {
    await act(async () => root.unmount());
    container.remove();
    (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL(
      'https://poc.cedarpad.com/?canvas=cv_1',
    );
    window.history.replaceState(null, '', '/?canvas=cv_1');
    await mountShell();

    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/w/ws_abc/canvas/cv_1/pad');
  });

  test('a stale ?canvas=<id> naming a deleted canvas is dropped once the registry loads', async () => {
    await act(async () => root.unmount());
    container.remove();
    (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL(
      'https://poc.cedarpad.com/?canvas=cv_gone',
    );
    window.history.replaceState(null, '', '/?canvas=cv_gone');
    await mountShell();

    await waitFor(() => window.location.search === '');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.pad-empty')).not.toBeNull();
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

// Notebook as a Shell stage (PRD #103, slice #107): it lazily mounts the real WebPocApp —
// no more placeholder — and its own AppShell.Header is gone, so the rail is the only chrome.
describe('the notebook stage mounts WebPocApp with no second chrome', () => {
  test('renders the Library sub-nav with zero <header> elements in the tree', async () => {
    await click(byTitle('Notebook'));
    await waitFor(() => /Library/.test(container.querySelector('.stage-notebook')?.textContent ?? ''));

    expect(container.querySelectorAll('header').length).toBe(0);
    expect(container.querySelector('.stage-notebook')?.textContent).toContain('Library');
    expect(container.querySelector('.stage-notebook')?.textContent).toContain('Knowledge Graph');
  });

  test('the Library/Knowledge Graph sub-nav switches views inside the stage, lazy-loading the graph', async () => {
    await click(byTitle('Notebook'));
    await waitFor(() => /Library/.test(container.querySelector('.stage-notebook')?.textContent ?? ''));

    const graphNav = [...container.querySelectorAll('.stage-notebook button')].find(
      (b) => b.textContent === 'Knowledge Graph',
    );
    await click(graphNav ?? null);
    await waitFor(() => calls.some((c) => c.startsWith('GET') && c.includes('/v1/graph')));

    expect(calls.some((c) => c.includes('/v1/graph'))).toBe(true);
  });

  test('scopes its queries to the rail’s active workspace, not an in-Notebook picker', async () => {
    await click(byTitle('Notebook'));
    // The very first /v1/items fetch can race the workspace-seeding effect and go out
    // unscoped; wait for the scoped refetch that follows once scopeWorkspaceId updates.
    await waitFor(() => calls.some((c) => c.includes('/v1/items') && c.includes('workspaceId=ws_abc')));

    // /api/canvases (fetched by the Shell itself) reported ws_abc as the active workspace.
    expect(calls.some((c) => c.includes('/v1/items') && c.includes('workspaceId=ws_abc'))).toBe(true);
  });
});
