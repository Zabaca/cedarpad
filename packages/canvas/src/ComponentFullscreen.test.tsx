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

function makeEditor(initial: Rec | undefined) {
  const shapes = new Map<string, Rec>(initial ? [[initial.id, initial]] : []);
  const listeners = new Set<() => void>();
  const editor = {
    getShape: (id: string) => shapes.get(id),
    // ComponentHost mirrors status onto meta through this; the overlay itself never writes.
    updateShape: (p: { id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      const cur = shapes.get(p.id);
      if (!cur) return;
      shapes.set(p.id, { ...cur, ...(p.props ? { props: { ...cur.props, ...p.props } } : {}), ...(p.meta ? { meta: p.meta } : {}) });
    },
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
