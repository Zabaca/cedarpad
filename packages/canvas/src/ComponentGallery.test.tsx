// The component gallery places instances via POST /api/components/place. What is asserted
// here is WHERE they land: a card added while page two is open must not appear on page one.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentGallery } from './ComponentGallery';

const realFetch = globalThis.fetch;
const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  globalThis.fetch = realFetch;
});

function stubApi(posts: Array<Record<string, unknown>>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/components/place') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    if (url.includes('/api/components')) return Response.json({ components: ['Kanban'], details: [{ name: 'Kanban', description: '', tier: 'own' }] });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function placeFrom(currentPage: () => string | undefined) {
  const posts: Array<Record<string, unknown>> = [];
  stubApi(posts);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(<ComponentGallery viewportCenter={() => ({ x: 600, y: 400 })} currentPage={currentPage} onClose={() => {}} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    (el.querySelector('.gallery-card') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
  });
  return posts;
}

describe('ComponentGallery', () => {
  test('places onto the page the human is looking at', async () => {
    expect(await placeFrom(() => 'page:two')).toEqual([{ module: 'Kanban', x: 420, y: 270, w: 360, h: 260, page: 'page:two' }]);
  });

  test('sends no page on the first page, so the request is unchanged from before pages', async () => {
    expect(await placeFrom(() => undefined)).toEqual([{ module: 'Kanban', x: 420, y: 270, w: 360, h: 260 }]);
  });
});
