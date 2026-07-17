// The built-in component palette: lists the library over GET /api/components, filters,
// and places instances via POST /api/components/place at the viewport center.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentPalette, filterModules, placementAt } from './ComponentPalette';

const realFetch = globalThis.fetch;
const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  globalThis.fetch = realFetch;
});

function stubApi(components: string[], posts: Array<Record<string, unknown>>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/components/place') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    if (url.includes('/api/components')) return Response.json({ components });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function mount(center = { x: 600, y: 400 }) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(<ComponentPalette viewportCenter={() => center} onClose={() => {}} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return el;
}

describe('ComponentPalette', () => {
  test('lists the whole library', async () => {
    stubApi(['BarChart', 'Kanban', 'KpiCard'], []);
    const el = await mount();
    expect([...el.querySelectorAll('.component-palette-name')].map((n) => n.textContent)).toEqual(['BarChart', 'Kanban', 'KpiCard']);
  });

  test('+ Add places the module centered on the viewport', async () => {
    const posts: Array<Record<string, unknown>> = [];
    stubApi(['Kanban'], posts);
    const el = await mount({ x: 600, y: 400 });
    await act(async () => {
      (el.querySelector('.component-palette-add') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(posts).toEqual([{ module: 'Kanban', x: 600 - 180, y: 400 - 130, w: 360, h: 260 }]);
  });
});

describe('placementAt', () => {
  test('cascades successive placements so instances do not stack', () => {
    const a = placementAt({ x: 0, y: 0 }, 0);
    const b = placementAt({ x: 0, y: 0 }, 1);
    expect(b.x - a.x).toBe(28);
    expect(b.y - a.y).toBe(28);
  });
});

describe('filterModules', () => {
  test('case-insensitive substring; blank keeps everything', () => {
    expect(filterModules(['BarChart', 'Kanban', 'KpiCard'], 'k')).toEqual(['Kanban', 'KpiCard']);
    expect(filterModules(['BarChart'], '  ')).toEqual(['BarChart']);
  });
});
