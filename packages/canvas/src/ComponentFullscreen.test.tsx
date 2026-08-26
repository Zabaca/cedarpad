// The ⛶ fullscreen flow: the expand bus routes a shape id to the registered handler,
// and the overlay renders the component's module fullscreen, closing on ✕ / Esc / when
// the shape disappears. The overlay renders a second ComponentHost against the SAME
// shape record, so it stays a live view (data writes re-render it).
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { requestExpand, setExpandHandler } from './component-expand';
import { ComponentFullscreenOverlay, type OverlayEditor } from './ComponentFullscreen';

describe('expand bus', () => {
  test('requestExpand routes to the registered handler; null unregisters', () => {
    const got: string[] = [];
    setExpandHandler((id) => got.push(id));
    requestExpand('shape:a');
    setExpandHandler(null);
    requestExpand('shape:b'); // no handler — must not throw
    expect(got).toEqual(['shape:a']);
  });
});

type Rec = { id: string; type: string; props: Record<string, unknown>; meta: Record<string, unknown> };

type ZoomCall = { id: string | undefined; opts?: { animation?: unknown } };

function makeEditor(initial: Rec | Rec[] | undefined) {
  const list = initial === undefined ? [] : Array.isArray(initial) ? initial : [initial];
  const shapes = new Map<string, Rec>(list.map((r) => [r.id, r]));
  const listeners = new Set<() => void>();
  const selected: string[] = [];
  const zoomed: ZoomCall[] = [];
  const editor = {
    getShape: (id: string) => shapes.get(id),
    // ComponentHost mirrors status onto meta through this; the overlay itself never writes.
    updateShape: (p: { id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      const cur = shapes.get(p.id);
      if (!cur) return;
      shapes.set(p.id, { ...cur, ...(p.props ? { props: { ...cur.props, ...p.props } } : {}), ...(p.meta ? { meta: p.meta } : {}) });
    },
    // The four operations the rail widened OverlayEditor by.
    getCurrentPageShapes: () => [...shapes.values()],
    getShapePageBounds: (id: string) => (shapes.has(id) ? { x: 0, y: 0, w: 10, h: 10 } : undefined),
    select: (id: string) => selected.push(id),
    zoomToBounds: (_b: unknown, opts?: { animation?: unknown }) => zoomed.push({ id: selected[selected.length - 1], opts }),
    store: {
      listen: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    delete: (id: string) => {
      shapes.delete(id);
      for (const cb of listeners) cb();
    },
    add: (r: Rec) => {
      shapes.set(r.id, r);
      for (const cb of listeners) cb();
    },
    selected,
    zoomed,
  };
  return editor;
}

// Unmount between tests: a mounted overlay's Esc handler stopImmediatePropagation()s,
// which would swallow the next test's Escape before its own listener runs.
const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

async function render(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(node as never);
  });
  return { el, root };
}

const shape: Rec = { id: 'shape:c1', type: 'component', props: { w: 100, h: 100, module: 'KpiBoard', data: {}, rev: 1 }, meta: {} };

describe('ComponentFullscreenOverlay', () => {
  test('renders the module fullscreen with a working close button', async () => {
    const editor = makeEditor({ ...shape });
    let closed = 0;
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId={shape.id} onClose={() => closed++} />,
    );
    expect(el.querySelector('.component-fullscreen')).not.toBeNull();
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('KpiBoard');
    await act(async () => {
      (el.querySelector('.component-fullscreen-close') as HTMLButtonElement).click();
    });
    expect(closed).toBe(1);
  });

  test('Escape closes', async () => {
    const editor = makeEditor({ ...shape });
    let closed = 0;
    await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId={shape.id} onClose={() => closed++} />,
    );
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(1);
  });

  test('closes itself when the shape is deleted (e.g. by a remote peer)', async () => {
    const editor = makeEditor({ ...shape });
    let closed = 0;
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId={shape.id} onClose={() => closed++} />,
    );
    await act(async () => {
      editor.delete(shape.id);
    });
    expect(closed).toBe(1);
    expect(el.querySelector('.component-fullscreen')).toBeNull();
  });
});

// PRD #221: the fullscreen header Share panel — members mint component-scoped links.
import { resetGuestScopeForTests } from '../shared/guest-scope';

describe('ShareControls (#221)', () => {
  test('a member mints a link scoped to this shape and sees its URL', async () => {
    resetGuestScopeForTests();
    const calls: string[] = [];
    let minted = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.includes('/api/guest-session')) return Response.json(null); // member
      if (url.includes('/share-links') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ shapeId: shape.id });
        minted = true;
        return Response.json({ id: 'sl_c1', shapeId: shape.id }, { status: 201 });
      }
      if (url.includes('/share-links')) {
        return Response.json({ links: minted ? [{ id: 'sl_c1', shapeId: shape.id, revokedAt: null }] : [] });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const editor = makeEditor({ ...shape });
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId={shape.id} onClose={() => {}} />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20)); // guest probe resolves → member
    });
    await act(async () => {
      (el.querySelector('.component-share-toggle') as HTMLButtonElement).click();
    });
    await act(async () => {
      (el.querySelector('.component-share-new') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(el.querySelector('.component-share-url')?.textContent).toContain('/share/sl_c1');
    globalThis.fetch = realFetch;
  });

  test('a guest sees no Share affordance', async () => {
    resetGuestScopeForTests();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/guest-session')) return Response.json({ canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: false });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const editor = makeEditor({ ...shape });
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId={shape.id} onClose={() => {}} />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(el.querySelector('.component-share-toggle')).toBeNull();
    globalThis.fetch = realFetch;
  });
});

// The fullscreen rail: fullscreen browses the components on the current canvas page
// instead of showing exactly one. Navigation is buttons + rail rows only — no key
// bindings, so nothing competes with a component's own keyboard handling.
const RAIL_KEY = 'agent-canvas:fullscreen-rail';

function rec(id: string, module: string): Rec {
  return { id, type: 'component', props: { w: 100, h: 100, module, data: {}, rev: 1 }, meta: {} };
}

describe('fullscreen rail', () => {
  afterEach(() => localStorage.removeItem(RAIL_KEY));

  test('a single component on the page renders neither rail nor arrows', async () => {
    const editor = makeEditor(rec('shape:a', 'KpiBoard'));
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    expect(el.querySelector('.component-fullscreen-rail')).toBeNull();
    expect(el.querySelector('.component-fullscreen-next')).toBeNull();
    expect(el.querySelector('.component-fullscreen-prev')).toBeNull();
  });

  test('two or more components render the rail, listing them in page order', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart'), rec('shape:c', 'Kanban')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    const labels = [...el.querySelectorAll('.component-fullscreen-rail .instance-list-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Kanban 1', 'Chart', 'Kanban 2']);
  });

  test('the header shows the numbered label, and the viewed row is marked active', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Kanban')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:b" onClose={() => {}} />,
    );
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Kanban 2');
    const rows = [...el.querySelectorAll('.component-fullscreen-rail .instance-list-row')];
    expect(rows.map((r) => r.getAttribute('data-active'))).toEqual([null, 'true']);
  });

  test('clicking a rail row switches the view to that component', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    await act(async () => {
      (el.querySelectorAll('.component-fullscreen-rail .instance-list-label')[1] as HTMLButtonElement).click();
    });
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Chart');
  });

  test('the rail offers no ⛶ — you are already fullscreen', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    expect(el.querySelectorAll('.component-fullscreen-rail .instance-list-expand').length).toBe(0);
  });

  test('› advances and ‹ steps back', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart'), rec('shape:c', 'Slide')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    const next = el.querySelector('.component-fullscreen-next') as HTMLButtonElement;
    const prev = el.querySelector('.component-fullscreen-prev') as HTMLButtonElement;
    await act(async () => next.click());
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Chart');
    await act(async () => next.click());
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Slide');
    await act(async () => prev.click());
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Chart');
  });

  test('both arrows wrap at the ends', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:b" onClose={() => {}} />,
    );
    await act(async () => (el.querySelector('.component-fullscreen-next') as HTMLButtonElement).click());
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Kanban');
    await act(async () => (el.querySelector('.component-fullscreen-prev') as HTMLButtonElement).click());
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Chart');
  });

  test('navigating selects the target and zooms the canvas to it with no animation', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    await act(async () => (el.querySelector('.component-fullscreen-next') as HTMLButtonElement).click());
    expect(editor.selected).toEqual(['shape:b']);
    expect(editor.zoomed.length).toBe(1);
    expect(editor.zoomed[0]?.opts?.animation).toBeUndefined();
  });

  test('deleting the viewed component advances to the next instead of closing', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    let closed = 0;
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => closed++} />,
    );
    await act(async () => editor.delete('shape:a'));
    expect(closed).toBe(0);
    expect(el.querySelector('.component-fullscreen-title')?.textContent).toBe('Chart');
  });

  test('deleting the last component closes fullscreen', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    let closed = 0;
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => closed++} />,
    );
    await act(async () => {
      editor.delete('shape:a');
      editor.delete('shape:b');
    });
    expect(closed).toBe(1);
    expect(el.querySelector('.component-fullscreen')).toBeNull();
  });

  test('the rail appears once a second component lands on the page', async () => {
    const editor = makeEditor(rec('shape:a', 'Kanban'));
    const { el } = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    expect(el.querySelector('.component-fullscreen-rail')).toBeNull();
    await act(async () => editor.add(rec('shape:b', 'Chart')));
    expect(el.querySelector('.component-fullscreen-rail')).not.toBeNull();
  });

  test('the rail collapses, and the choice survives a remount', async () => {
    const editor = makeEditor([rec('shape:a', 'Kanban'), rec('shape:b', 'Chart')]);
    const first = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    expect(first.el.querySelector('.component-fullscreen-rail')).not.toBeNull();
    await act(async () => (first.el.querySelector('.component-fullscreen-rail-toggle') as HTMLButtonElement).click());
    expect(first.el.querySelector('.component-fullscreen-rail')).toBeNull();

    const second = await render(
      <ComponentFullscreenOverlay editor={editor as unknown as OverlayEditor} shapeId="shape:a" onClose={() => {}} />,
    );
    expect(second.el.querySelector('.component-fullscreen-rail')).toBeNull();
    // The arrows stay reachable with the rail collapsed.
    expect(second.el.querySelector('.component-fullscreen-next')).not.toBeNull();
  });
});
