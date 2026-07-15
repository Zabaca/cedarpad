// Register happy-dom (window/document/Element) BEFORE importing ComponentShape: it
// pulls in tldraw's runtime, which touches the DOM at module-eval. This side-effect
// import MUST stay first. See happydom-harness.ts.
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from 'tldraw';

// React's `act` only flushes effects when this flag is set (we're a test renderer).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentHost, sameStatus } from './ComponentShape';
import type { ComponentShapeMeta } from './ComponentShape';
import { LOAD_ATTEMPTS } from './component-loader';
import type { AgentComponent } from './component-loader';

// A minimal shape record + editor stub: the host only ever calls getShape / updateShape.
// updateShape REPLACES `meta` (tldraw partial semantics, since the host spreads the
// prior meta itself), so this mirrors the real editor closely enough for meta.status.
type Rec = { id: string; type: string; props: Record<string, unknown>; meta: ComponentShapeMeta };

function makeEditor(initial: Rec) {
  const shapes = new Map<string, Rec>([[initial.id, initial]]);
  let metaWrites = 0;
  const editor = {
    getShape: (id: string) => shapes.get(id),
    updateShape: (p: { id: string; props?: Record<string, unknown>; meta?: ComponentShapeMeta }) => {
      const cur = shapes.get(p.id);
      if (!cur) return;
      if (p.meta) metaWrites++;
      shapes.set(p.id, {
        ...cur,
        ...(p.props ? { props: { ...cur.props, ...p.props } } : {}),
        ...(p.meta ? { meta: p.meta } : {}),
      });
    },
  };
  return {
    editor: editor as unknown as Editor,
    status: () => shapes.get(initial.id)?.meta.status,
    metaWrites: () => metaWrites,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const Dummy: AgentComponent = () => React.createElement('div', null, 'ok');

function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    mount: () => act(async () => void root.render(node)),
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
}

describe('ComponentHost meta.status seam (happy path)', () => {
  test('mounting a module that resolves transitions meta.status loading → ready', async () => {
    const ed = makeEditor({
      id: 'shape:test',
      type: 'component',
      props: { w: 360, h: 260, module: 'Kpi', data: {}, rev: 0 },
      meta: {}, // legacy/fresh shape: no status yet
    });
    expect(ed.status()).toBeUndefined(); // an un-stamped shape is valid (optional field)

    const d = deferred<AgentComponent>();
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:test',
        editor: ed.editor,
        module: 'Kpi',
        data: {},
        rev: 0,
        load: () => d.promise,
      }),
    );

    // Mount writes `loading` in the effect, before the loader resolves.
    await host.mount();
    expect(ed.status()).toEqual({ phase: 'loading', attempt: 1 });

    // Resolving the load flips it to `ready`.
    await act(async () => {
      d.resolve(Dummy);
    });
    expect(ed.status()).toEqual({ phase: 'ready' });

    // Exactly two meta writes happened (loading, then ready): no redundant churn.
    expect(ed.metaWrites()).toBe(2);

    await host.unmount();
  });
});

describe('ComponentHost meta.status seam (load_error)', () => {
  test('a load that ultimately rejects writes load_error with the configured attempt budget', async () => {
    const ed = makeEditor({
      id: 'shape:test',
      type: 'component',
      props: { w: 360, h: 260, module: 'Ghost', data: {}, rev: 0 },
      meta: {}, // a module that does not exist on disk
    });

    // The injected loader stands in for loadComponent AFTER its internal retry budget
    // is exhausted: it rejects, exactly as the real loader does for a missing module
    // (using the stub keeps the test off the loader's real ~4.5s backoff).
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:test',
        editor: ed.editor,
        module: 'Ghost',
        data: {},
        rev: 0,
        load: () => Promise.reject(new Error('Failed to fetch dynamically imported module: Ghost')),
      }),
    );

    await host.mount();
    // Drain the rejected-load microtask + the error-state re-render.
    await act(async () => {});

    const s = ed.status();
    expect(s?.phase).toBe('load_error');
    if (s?.phase === 'load_error') {
      expect(s.attempts).toBe(LOAD_ATTEMPTS); // the loader's configured budget
      expect(s.message.length).toBeGreaterThan(0);
    }

    await host.unmount();
  });
});

describe('ComponentHost meta.status seam (render_error)', () => {
  test('a component that throws on render trips the boundary into render_error with a source frame', async () => {
    const ed = makeEditor({
      id: 'shape:test',
      type: 'component',
      props: { w: 360, h: 260, module: 'Boom', data: {}, rev: 0 },
      meta: {},
    });

    // Loads fine, then throws when React renders it: the load_error vs render_error split.
    const Throwing: AgentComponent = () => {
      throw new Error('render boom');
    };

    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:test',
        editor: ed.editor,
        module: 'Boom',
        data: {},
        rev: 0,
        load: () => Promise.resolve(Throwing),
      }),
    );

    await host.mount();
    // Drain: load resolves → ready → render → throw → boundary catch → render_error.
    await act(async () => {});

    const s = ed.status();
    expect(s?.phase).toBe('render_error');
    if (s?.phase === 'render_error') {
      expect(s.message).toContain('render boom');
      expect(s.where.length).toBeGreaterThan(0); // a real source frame, not blank
    }

    await host.unmount();
  });
});

describe('sameStatus: the idempotency guard', () => {
  test('treats an absent status as never-equal (the first write always lands)', () => {
    expect(sameStatus(undefined, { phase: 'ready' })).toBe(false);
  });

  test('equal phase + payload is a no-op; a differing payload is not', () => {
    expect(sameStatus({ phase: 'ready' }, { phase: 'ready' })).toBe(true);
    expect(sameStatus({ phase: 'loading', attempt: 1 }, { phase: 'loading', attempt: 1 })).toBe(true);
    // Same phase, different attempt (a retry) must still write.
    expect(sameStatus({ phase: 'loading', attempt: 1 }, { phase: 'loading', attempt: 2 })).toBe(false);
    // Different phase always writes.
    expect(sameStatus({ phase: 'loading', attempt: 1 }, { phase: 'ready' })).toBe(false);
  });
});

// #211: identity rides alongside data/setData into every rendered instance.
describe('ComponentHost injects currentUser + setDisplayName', () => {
  test('the rendered component receives the identity props (guest in this env)', async () => {
    const ed = makeEditor({
      id: 'shape:idn',
      type: 'component',
      props: { w: 360, h: 260, module: 'Probe', data: { x: 1 }, rev: 0 },
      meta: {},
    });
    let seen: Record<string, unknown> | null = null;
    const Probe: AgentComponent = (props) => {
      seen = props;
      return React.createElement('div', null, 'probe');
    };
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:idn',
        editor: ed.editor,
        module: 'Probe',
        data: { x: 1 },
        rev: 0,
        load: async () => Probe,
      }),
    );
    await host.mount();
    // The identity singleton resolves async (fetch fails here → guest); poll briefly.
    for (let i = 0; i < 20 && !(seen as Record<string, unknown> | null)?.currentUser; i++) {
      await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    }
    const props = seen as unknown as {
      x: number;
      setData: unknown;
      setDisplayName: unknown;
      currentUser?: { id: string; kind: string; color: string };
    };
    expect(props.x).toBe(1); // data still spreads through
    expect(typeof props.setData).toBe('function');
    expect(typeof props.setDisplayName).toBe('function');
    expect(props.currentUser?.kind).toBe('guest');
    expect(props.currentUser?.id).toMatch(/^guest_/);
    expect(props.currentUser?.color).toMatch(/^hsl\(/);
    await host.unmount();
  });
});
