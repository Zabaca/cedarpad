// Component-guest mode (PRD #221): the pad renders ONE shape's component fullscreen off
// the bridge's simplified canvas model — no tldraw. These tests drive the view through
// its public surface: the canvas doc fetch, the SSE stream, and the adapter's data writes.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentGuestView, createGuestShapeStore } from './ComponentGuestView';
import type { ComponentShape } from './shapes';

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: unknown;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const model: ComponentShape = { id: 'shape:c1', type: 'component', x: 0, y: 0, w: 100, h: 100, color: 'black', module: 'KpiBoard', data: { n: 1 }, rev: 1 } as ComponentShape;

const realFetch = globalThis.fetch;
const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  globalThis.fetch = realFetch;
});

function stubFetch(doc: unknown, posts: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === 'POST') {
      posts.push(String(init.body));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/canvas')) return Response.json(doc);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function mount(shapeId: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(<ComponentGuestView shapeId={shapeId} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return el;
}

describe('ComponentGuestView (#221)', () => {
  test('renders the linked shape fullscreen and follows remote data over the stream', async () => {
    stubFetch({ shapes: [model] }, []);
    const el = await mount('shape:c1');
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('KpiBoard');
    // No close button, no chat, no tldraw — this IS the whole surface.
    expect(el.querySelector('.component-fullscreen-close')).toBeNull();

    // A member deletes the shape → the view degrades to "no longer available".
    await act(async () => {
      FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ shapes: [] }) });
    });
    expect(el.querySelector('.component-guest-empty')?.textContent).toContain('no longer available');
  });

  test('a link to a missing shape shows the empty state, not a broken canvas', async () => {
    stubFetch({ shapes: [] }, []);
    const el = await mount('shape:nope');
    expect(el.querySelector('.component-guest-empty')).not.toBeNull();
  });
});

describe('createGuestShapeStore adapter', () => {
  test('a setData-style update POSTs the full shape back to the bridge and notifies', async () => {
    const posts: string[] = [];
    stubFetch({ shapes: [model] }, posts);
    const store = createGuestShapeStore({ ...model });
    let notified = 0;
    store.editor.store.listen(() => notified++);
    store.editor.updateShape({ id: model.id, props: { data: { n: 2 } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toBe(1);
    expect(posts.length).toBe(1);
    const sent = JSON.parse(posts[0] as string) as { shapes: Array<{ id: string; data: Record<string, unknown> }> };
    expect(sent.shapes[0]?.id).toBe(model.id);
    expect(sent.shapes[0]?.data).toEqual({ n: 2 });
  });

  test('meta (status) writes stay local — no bridge POST', async () => {
    const posts: string[] = [];
    stubFetch({ shapes: [model] }, posts);
    const store = createGuestShapeStore({ ...model });
    store.editor.updateShape({ id: model.id, meta: { status: { phase: 'ready' } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(posts.length).toBe(0);
    expect(store.editor.getShape(model.id as never)?.meta).toEqual({ status: { phase: 'ready' } });
  });
});
