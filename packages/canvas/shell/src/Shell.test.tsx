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
    if (url.startsWith('/api/inbox?')) return Response.json({ items: [] });
    // Better Auth's session check, so the lazily-mounted Notebook (slice #107) renders its
    // authenticated view instead of <AuthScreen/> — the Shell itself already sits behind
    // the edge auth gate, so under the Shell this always resolves.
    if (url.endsWith('/api/auth/get-session')) {
      return Response.json({ session: { id: 'sess_1' }, user: { id: 'u_1', email: 'demo@example.com' } });
    }
    if (url.endsWith('/api/auth/sign-out')) return Response.json({ success: true });
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
    // The trailing row is the always-present settings link (#192).
    expect(rows.map((r) => r.querySelector('.lp-ws-name')?.textContent)).toEqual(['Default', 'Zabaca', 'Workspace settings…']);
    // /api/canvases reported ws_abc as the active scope.
    expect(rows[1]?.className).toContain('active');
  });
});

// #179: the popover's owner-only invite affordance. The server is the authority on
// "owner": the pending-invitations GET returns 200 only for the owner (403 member,
// 404 stranger) — a non-200 leaves the popover invite-free.
describe('the workspace popover invites (owner-only, #179)', () => {
  test('an owner sees Invite; clicking it POSTs the email and surfaces the link', async () => {
    const prompts: string[] = [];
    let promptCount = 0;
    (globalThis as { prompt?: (msg?: string, def?: string) => string | null }).prompt = (msg?: string, def?: string) => {
      prompts.push(`${msg ?? ''}|${def ?? ''}`);
      return promptCount++ === 0 ? 'jae@example.com' : null; // first prompt: the email; second: the link display
    };
    const inviteUrl = '/api/workspaces/ws_abc/invitations';
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === inviteUrl && (init?.method ?? 'GET') === 'GET') {
        calls.push(`GET ${url}`);
        return Response.json({ invitations: [] });
      }
      if (url === inviteUrl && init?.method === 'POST') {
        calls.push(`POST ${url}`);
        return Response.json({ token: 'wi_t1', email: 'jae@example.com', url: '/invite/wi_t1', expiresAt: 1 }, { status: 201 });
      }
      return stubbed(input as never, init);
    }) as typeof fetch;

    await click(container.querySelector('.lp-z'));
    const invite = container.querySelector('.lp-ws-invite');
    expect(invite).not.toBeNull();

    await click(invite);
    expect(calls).toContain(`POST ${inviteUrl}`);
    // The second prompt shows the copyable absolute link.
    expect(prompts[1]).toContain('/invite/wi_t1');
  });

  test('a non-owner (403 on the pending list) gets no invite affordance', async () => {
    await click(container.querySelector('.lp-z')); // stubEdge 404s the invitations GET
    expect(container.querySelector('.lp-ws-invite')).toBeNull();
  });
});

describe('the avatar signs out through the edge Better Auth endpoint', () => {
  test('Sign out POSTs /api/auth/sign-out', async () => {
    await click(byTitle('Account'));
    await click(container.querySelector('.lp-signout'));

    expect(calls).toContain('POST /api/auth/sign-out');
  });

  // Regression: a failed sign-out (network error or non-2xx) used to still navigate to `/`
  // unconditionally — the gate still saw the (uncleared) session cookie and handed back the
  // authenticated shell, which read to the user as "sign out did nothing".
  test('a failed sign-out does NOT navigate away (so it never silently looks like a no-op)', async () => {
    const failing = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/auth/sign-out')) return new Response('nope', { status: 500 });
      return failing(input as never, init);
    }) as typeof fetch;

    const originalHref = window.location.href;
    const alerts: string[] = [];
    const originalAlert = window.alert;
    window.alert = ((msg: string) => alerts.push(msg)) as typeof window.alert;

    await click(byTitle('Account'));
    await click(container.querySelector('.lp-signout'));

    expect(window.location.href).toBe(originalHref);
    expect(alerts).toEqual(['Could not sign out — try again.']);

    window.alert = originalAlert;
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

// The rail used to build a fresh urlForStage(next) on every click, dropping whatever
// query params the outgoing stage had accumulated (canvas's ?canvas=<id>, inbox's filters).
// A reload restored them fine (they're read from the URL on mount); rail navigation didn't.
// Stage memory (stage-memory.ts) closes that gap.
describe('the rail remembers each stage’s URL state across navigation', () => {
  test('picking a canvas, leaving to Inbox, and returning to Canvases restores ?canvas=', async () => {
    await click([...container.querySelectorAll('.page-row')][1] ?? null);
    expect(window.location.search).toBe('?canvas=cv_1');

    await click(byTitle('Inbox'));
    expect(window.location.search).toBe('?stage=inbox');

    await click(byTitle('Canvases'));
    expect(window.location.search).toBe('?canvas=cv_1');
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/w/ws_abc/canvas/cv_1/pad');
  });

  test('changing the inbox view filter, leaving, and returning restores it', async () => {
    await click(byTitle('Inbox'));
    await waitFor(() => calls.includes('GET /api/inbox?view=open')); // 'open' is the default view

    const viewSelect = container.querySelector<HTMLSelectElement>('[aria-label="View filter"]');
    expect(viewSelect).not.toBeNull();
    await act(async () => {
      viewSelect!.value = 'closed'; // a NON-default view, so it lands in the URL
      viewSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(window.location.search).toBe('?stage=inbox&view=closed');

    await click(byTitle('Notebook'));
    expect(window.location.search).toBe('?stage=notebook');

    await click(byTitle('Inbox'));
    expect(window.location.search).toBe('?stage=inbox&view=closed');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="View filter"]')?.value).toBe('closed');
  });

  test('a stage’s first visit still gets the bare urlForStage default', async () => {
    await click(byTitle('Jobs'));
    expect(window.location.search).toBe('?stage=jobs');
  });
});

// The docked chat panel (CONTEXT.md "Docked chat"): a chat card in the embedded pad can be
// docked into a Shell-level pane beside the pad — a MIRROR (the card stays), one slot per
// canvas, remembered per device. The pad's dock gesture is the one postMessage that crosses
// the iframe boundary; everything else converges at the bridge.
describe('the docked chat panel on the canvas stage', () => {
  // <ChatView> opens the shared SSE stream on mount; happy-dom has no EventSource, so stub
  // a no-op that reports "open" (same shape as Inbox.test.tsx's stub).
  class StubEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      setTimeout(() => this.onopen?.(), 0);
    }
    close() {}
  }
  const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

  beforeEach(() => {
    (globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown;
    localStorage.clear();
  });
  afterEach(() => {
    (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
    localStorage.clear();
  });

  /** The pad's dock gesture, as the Shell receives it: a same-origin window message. */
  const post = async (data: unknown, origin = 'https://poc.cedarpad.com') => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  const openRoadmap = async () => {
    await click([...container.querySelectorAll('.page-row')][1] ?? null); // cv_1 "Roadmap"
  };

  test('a dock message from the pad mounts the chat panel with a live ChatView', async () => {
    await openRoadmap();
    expect(container.querySelector('.canvas-dock')).toBeNull(); // nothing docked yet

    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:c1', title: 'Fix login' });

    const panel = container.querySelector('.canvas-dock');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('.canvas-dock-head')?.textContent).toContain('Fix login');
    expect(panel?.querySelector('.chat-card')).not.toBeNull(); // the SAME shared ChatView
    expect(container.querySelector('iframe')).not.toBeNull(); // mirror: the pad stays mounted
  });

  test('one slot: docking a second chat replaces the first (mirror — nothing is lost)', async () => {
    await openRoadmap();
    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:c1', title: 'Fix login' });
    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:c2', title: 'Deploy fix' });

    const heads = [...container.querySelectorAll('.canvas-dock-head')];
    expect(heads).toHaveLength(1); // still one panel, not two
    expect(heads[0]?.textContent).toContain('Deploy fix');
  });

  test('a wrong-origin or foreign-shaped message never docks anything', async () => {
    await openRoadmap();
    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:evil', title: 'evil' }, 'https://attacker.example');
    await post({ type: 'webpack-dev-server', chatId: 'shape:noise' });

    expect(container.querySelector('.canvas-dock')).toBeNull();
  });

  test('the ✕ undocks: the panel unmounts and the pad takes the width back', async () => {
    await openRoadmap();
    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:c1', title: 'Fix login' });
    expect(container.querySelector('.canvas-dock')).not.toBeNull();

    await click(container.querySelector('[aria-label="Undock chat"]'));

    expect(container.querySelector('.canvas-dock')).toBeNull();
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  test('deleting the docked chat’s card undocks (the panel is a projection of the card)', async () => {
    await openRoadmap();
    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:c1', title: 'Fix login' });

    await post({ type: 'cedarpad:chat-deleted', chatId: 'shape:other' }); // some OTHER card
    expect(container.querySelector('.canvas-dock')).not.toBeNull(); // unaffected

    await post({ type: 'cedarpad:chat-deleted', chatId: 'shape:c1' }); // the docked one
    expect(container.querySelector('.canvas-dock')).toBeNull();
  });

  test('the dock is remembered per canvas: switching canvases swaps it, and a reload restores it', async () => {
    await openRoadmap();
    await post({ type: 'cedarpad:dock-chat', chatId: 'shape:c1', title: 'Fix login' });

    // Another canvas has its own (empty) slot…
    await click([...container.querySelectorAll('.page-row')][0] ?? null); // Default
    expect(container.querySelector('.canvas-dock')).toBeNull();
    // …and coming back restores this one's.
    await click([...container.querySelectorAll('.page-row')][1] ?? null); // Roadmap
    expect(container.querySelector('.canvas-dock-head')?.textContent).toContain('Fix login');

    // A fresh mount (reload) restores it from device memory.
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/?canvas=cv_1');
    await mountShell();
    expect(container.querySelector('.canvas-dock-head')?.textContent).toContain('Fix login');
  });
});
