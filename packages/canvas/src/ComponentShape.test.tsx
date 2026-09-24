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
import type { CanvasShape } from './shapes';
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
    data: () => shapes.get(initial.id)?.props.data as Record<string, unknown> | undefined,
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

// tldraw validates `props.data` as JSON, and an `undefined` VALUE is not JSON — it throws
// and the whole tab falls over to "Something went wrong". `setData` therefore drops keys
// whose value is undefined rather than storing them.
describe('ComponentHost setData seam — undefined values never reach props.data', () => {
  test('a patch with an undefined value stores the defined keys only, and clears nothing else', async () => {
    const ed = makeEditor({
      id: 'shape:sd',
      type: 'component',
      props: { w: 360, h: 260, module: 'Probe', data: { kept: 'before' }, rev: 0 },
      meta: {},
    });
    let seen: { setData: (patch: Record<string, unknown>) => void } | null = null;
    const Probe: AgentComponent = (props) => {
      seen = props as unknown as typeof seen;
      return React.createElement('div', null, 'probe');
    };
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:sd',
        editor: ed.editor,
        module: 'Probe',
        data: { kept: 'before' },
        rev: 0,
        load: async () => Probe,
      }),
    );
    await host.mount();
    await act(async () => {});

    await act(async () => void seen!.setData({ answer: 42, pending: undefined }));

    expect(ed.data()).toEqual({ kept: 'before', answer: 42 });
    expect(Object.keys(ed.data()!)).toEqual(['kept', 'answer']); // no `pending` key at all
    await host.unmount();
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

// The reply-target seam: the host injects a `sendToAgent` bound to the chat THIS component
// is attached to (its inbound arrow), resolved fresh at send time. readShapes + post are
// injected so the real resolveReplyTarget runs against fixtures and the POST is observable.
describe('ComponentHost injects a link-bound sendToAgent', () => {
  const chatCard = (id: string, chatId: string): CanvasShape =>
    ({ type: 'chat', id, color: 'grey', x: 0, y: 0, w: 380, h: 460, title: '', chatId }) as CanvasShape;
  const comp = (id: string): CanvasShape =>
    ({ type: 'component', id, color: 'grey', x: 0, y: 0, w: 360, h: 260, module: 'Sender', data: {}, rev: 0 }) as CanvasShape;
  const link = (id: string, from: string, to: string): CanvasShape =>
    ({ type: 'arrow', id, color: 'grey', x1: 0, y1: 0, x2: 0, y2: 0, text: '', startShapeId: from, endShapeId: to }) as CanvasShape;

  let captured: { sendToAgent: (m: string) => Promise<void> } | null = null;
  const Sender: AgentComponent = (props) => {
    captured = props as unknown as { sendToAgent: (m: string) => Promise<void> };
    return React.createElement('div', null, 'sender');
  };

  test('posts a message into the chat the component is attached to', async () => {
    captured = null;
    const ed = makeEditor({ id: 'shape:comp', type: 'component', props: { w: 360, h: 260, module: 'Sender', data: {}, rev: 0 }, meta: {} });
    const shapes = [chatCard('shape:cardX', 'conv_abc'), comp('shape:comp'), link('shape:arr', 'shape:cardX', 'shape:comp')];
    const posts: Array<{ chatId: string; message: string }> = [];
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:comp',
        editor: ed.editor,
        module: 'Sender',
        data: {},
        rev: 0,
        load: async () => Sender,
        readShapes: () => shapes,
        post: async (chatId: string, message: string) => void posts.push({ chatId, message }),
      }),
    );
    await host.mount();
    await act(async () => {});
    await act(async () => {
      await captured!.sendToAgent('hi there');
    });
    expect(posts).toEqual([{ chatId: 'conv_abc', message: 'hi there' }]);
    await host.unmount();
  });

  test('with no link and no focused chat, sending rejects and never POSTs', async () => {
    captured = null;
    const ed = makeEditor({ id: 'shape:comp', type: 'component', props: { w: 360, h: 260, module: 'Sender', data: {}, rev: 0 }, meta: {} });
    const shapes = [comp('shape:comp')]; // orphan: no chat, no arrow; getActiveChat() is ''
    const posts: string[] = [];
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:comp',
        editor: ed.editor,
        module: 'Sender',
        data: {},
        rev: 0,
        load: async () => Sender,
        readShapes: () => shapes,
        post: async (chatId: string) => void posts.push(chatId),
      }),
    );
    await host.mount();
    await act(async () => {});
    let err: Error | null = null;
    await act(async () => {
      await captured!.sendToAgent('hi').catch((e: Error) => void (err = e));
    });
    expect(posts).toHaveLength(0);
    expect((err as unknown as Error)?.message).toMatch(/focus or attach a chat/i);
    await host.unmount();
  });
});

// #239 / ADR-0017: a component names a mart, never a URL — ComponentHost is where the
// name resolves into rows + freshness at render time, with no agent tool call.
describe('ComponentHost: mart-backed dataSource (#239)', () => {
  const Probe: AgentComponent = (props) => {
    (Probe as unknown as { lastProps: unknown }).lastProps = props;
    return React.createElement('div', null, 'probe');
  };

  test('no dataSource is fully backward compatible: static data reaches the component unchanged, no freshness badge', async () => {
    const ed = makeEditor({
      id: 'shape:static',
      type: 'component',
      props: { w: 360, h: 260, module: 'Probe', data: { x: 1 }, rev: 0 },
      meta: {},
    });
    let calledLoadMart = false;
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:static',
        editor: ed.editor,
        module: 'Probe',
        data: { x: 1 },
        rev: 0,
        load: async () => Probe,
        loadMart: async () => {
          calledLoadMart = true;
          throw new Error('should never be called');
        },
      }),
    );
    await host.mount();
    await act(async () => {});
    const props = (Probe as unknown as { lastProps: Record<string, unknown> }).lastProps;
    expect(props.x).toBe(1);
    expect(props.rows).toBeUndefined(); // no dataSource ⇒ no rows/mart keys added at all
    expect(props.mart).toBeUndefined();
    expect(calledLoadMart).toBe(false);
    expect(document.body.textContent).not.toContain('as of');
    await host.unmount();
  });

  test('a mart dataSource resolves rows + sidecar into props and shows freshness on the card', async () => {
    const ed = makeEditor({
      id: 'shape:mart',
      type: 'component',
      props: { w: 360, h: 260, module: 'Probe', data: {}, rev: 0 },
      meta: {},
    });
    const generatedAt = '2026-07-01T00:00:00.000Z';
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:mart',
        editor: ed.editor,
        module: 'Probe',
        data: {},
        rev: 0,
        dataSource: { kind: 'mart', name: 'mart_runway' },
        load: async () => Probe,
        loadMart: async (name: string) => {
          expect(name).toBe('mart_runway');
          return {
            rows: [{ month: 'Jan', burn: 1000 }],
            sidecar: { name: 'mart_runway', description: 'd', columns: [], generatedAt, rowCount: 1 },
          };
        },
      }),
    );
    await host.mount();
    await act(async () => {});
    const props = (Probe as unknown as { lastProps: Record<string, unknown> }).lastProps;
    expect(props.rows).toEqual([{ month: 'Jan', burn: 1000 }]);
    expect((props.mart as { rowCount: number }).rowCount).toBe(1);
    // Freshness is on the CARD itself, not dependent on the component using the props.
    expect(document.body.textContent).toContain('as of');
    expect(document.body.textContent).toContain('1 row');
    await host.unmount();
  });

  // A canvas reads the Notebook live (ADR-0024): the second member of the data-source
  // union resolves the same way — a NAME plus params, never a URL and never SQL.
  test('a notebook dataSource resolves its named query into rows props', async () => {
    const ed = makeEditor({
      id: 'shape:notebook',
      type: 'component',
      props: { w: 360, h: 260, module: 'Probe', data: {}, rev: 0 },
      meta: {},
    });
    const asked: { query: string; params?: Record<string, string | number> }[] = [];
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:notebook',
        editor: ed.editor,
        module: 'Probe',
        data: { title: 'Open problems' },
        rev: 0,
        dataSource: { kind: 'notebook', query: 'open_problems', params: { limit: 5 } },
        load: async () => Probe,
        loadMart: async () => {
          throw new Error('a notebook source must never take the mart path');
        },
        loadNotebook: async (query, params) => {
          asked.push({ query, params });
          return [{ id: 'prob_high', title: 'High priority', priority: 9 }];
        },
      }),
    );
    await host.mount();
    await act(async () => {});
    const props = (Probe as unknown as { lastProps: Record<string, unknown> }).lastProps;
    expect(asked).toEqual([{ query: 'open_problems', params: { limit: 5 } }]);
    expect(props.rows).toEqual([{ id: 'prob_high', title: 'High priority', priority: 9 }]);
    expect(props.title).toBe('Open problems'); // static data still reaches the component
    expect(props.mart).toBeNull(); // a notebook read has no materialize stamp — it is live
    await host.unmount();
  });

  test('a mart fetch error surfaces on the card as an error badge, without breaking the component', async () => {
    const ed = makeEditor({
      id: 'shape:mart-err',
      type: 'component',
      props: { w: 360, h: 260, module: 'Probe', data: {}, rev: 0 },
      meta: {},
    });
    const host = render(
      React.createElement(ComponentHost, {
        shapeId: 'shape:mart-err',
        editor: ed.editor,
        module: 'Probe',
        data: {},
        rev: 0,
        dataSource: { kind: 'mart', name: 'mart_missing' },
        load: async () => Probe,
        loadMart: async () => {
          throw new Error('mart "mart_missing" not found');
        },
      }),
    );
    await host.mount();
    await act(async () => {});
    expect(document.body.textContent).toContain('mart error');
    await host.unmount();
  });
});
