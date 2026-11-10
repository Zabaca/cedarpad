// Component-guest mode (PRD #221) on the sync room (#294, ADR-0019): the pad renders ONE
// shape's component fullscreen off a READ-ONLY connection to the canvas's TLSocketRoom —
// no tldraw editor, no SSE, no writes. These tests drive the two halves that carry the
// behaviour: the Editor-shaped adapter over the room's store, and the fullscreen host.
// The connection itself (`useSync`) is a thin wrapper tested at the Worker instead
// (worker/sync-api.test.ts, worker/sync-readonly.test.ts) — that is where a guest's
// inability to write is actually enforced.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createGuestShapeStore, GuestComponent, type GuestRoomStore } from './ComponentGuestView';

const SHAPE_ID = 'shape:c1';

const record = (data: Record<string, unknown>) => ({
  id: SHAPE_ID,
  typeName: 'shape' as const,
  type: 'component',
  props: { w: 100, h: 100, module: 'KpiBoard', data, rev: 1, dataSource: null },
});

/** A stand-in for the slice of tldraw's `TLStore` the guest path reads. `set` is the
 *  TEST's lever, standing for a member's edit arriving over the wire — the guest code
 *  has no such call, which is the point. */
function fakeRoomStore(initial: ReturnType<typeof record> | undefined) {
  let cur: ReturnType<typeof record> | undefined = initial;
  const listeners = new Set<() => void>();
  return {
    get: (_id: string) => cur as never,
    listen: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    set(next: ReturnType<typeof record> | undefined) {
      cur = next;
      for (const cb of listeners) cb();
    },
  } satisfies GuestRoomStore & { set(next: ReturnType<typeof record> | undefined): void };
}

const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

async function mount(store: GuestRoomStore) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(<GuestComponent store={store} shapeId={SHAPE_ID} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return el;
}

const dataOf = (adapter: ReturnType<typeof createGuestShapeStore>) =>
  (adapter.editor.getShape(SHAPE_ID as never)?.props as { data: unknown } | undefined)?.data;

describe('GuestComponent (#221 on the sync room)', () => {
  test('renders the linked shape fullscreen, straight off the room record', async () => {
    const el = await mount(fakeRoomStore(record({ n: 1 })));
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('KpiBoard');
    // No close button, no chat, no tldraw — this IS the whole surface.
    expect(el.querySelector('.component-fullscreen-close')).toBeNull();
  });

  test("follows a member's edit live", async () => {
    const store = fakeRoomStore(record({ n: 1 }));
    const el = await mount(store);
    const adapter = createGuestShapeStore(store, SHAPE_ID);
    expect(dataOf(adapter)).toEqual({ n: 1 });
    await act(async () => {
      store.set(record({ n: 42 }));
    });
    expect(dataOf(adapter)).toEqual({ n: 42 });
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('KpiBoard');
  });

  test('a member deleting the shape degrades to "no longer available"', async () => {
    const store = fakeRoomStore(record({ n: 1 }));
    const el = await mount(store);
    await act(async () => {
      store.set(undefined);
    });
    expect(el.querySelector('.component-guest-empty')?.textContent).toContain('no longer available');
  });

  test('a link to a missing shape shows the empty state, not a broken canvas', async () => {
    const el = await mount(fakeRoomStore(undefined));
    expect(el.querySelector('.component-guest-empty')).not.toBeNull();
  });
});

describe('createGuestShapeStore adapter — a guest writes nothing', () => {
  test('a setData-style update NEVER reaches the room; it stays in this tab', () => {
    const store = fakeRoomStore(record({ n: 1 }));
    const adapter = createGuestShapeStore(store, SHAPE_ID);
    let notified = 0;
    adapter.editor.store.listen(() => notified++);
    adapter.editor.updateShape({ id: SHAPE_ID, props: { data: { n: 2 } } });
    // The component re-renders with its own optimistic value...
    expect(notified).toBe(1);
    expect(dataOf(adapter)).toEqual({ n: 2 });
    // ...and the shared document is untouched. (Even if this leaked, the room's
    // read-only session would drop it — worker/sync-readonly.test.ts.)
    expect((store.get(SHAPE_ID) as unknown as { props: { data: unknown } }).props.data).toEqual({ n: 1 });
  });

  test("a member's edit wins over the guest's local one — the room is authoritative", () => {
    const store = fakeRoomStore(record({ n: 1 }));
    const adapter = createGuestShapeStore(store, SHAPE_ID);
    adapter.editor.updateShape({ id: SHAPE_ID, props: { data: { n: 2 } } });
    store.set(record({ n: 9 }));
    expect(dataOf(adapter)).toEqual({ n: 9 });
  });

  test("meta (status) writes stay local — a guest's load lifecycle is nobody else's business", () => {
    const store = fakeRoomStore(record({ n: 1 }));
    const adapter = createGuestShapeStore(store, SHAPE_ID);
    adapter.editor.updateShape({ id: SHAPE_ID, meta: { status: { phase: 'ready' } } });
    expect(adapter.editor.getShape(SHAPE_ID as never)?.meta).toEqual({ status: { phase: 'ready' } });
    expect((store.get(SHAPE_ID) as unknown as { meta?: unknown }).meta).toBeUndefined();
  });
});
