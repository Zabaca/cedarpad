import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import { fetchNotebook } from './notebook-data';

const setPath = (pathname: string) => {
  (globalThis as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`https://poc.cedarpad.com${pathname}`);
};

afterEach(() => {
  setPath('/');
  // @ts-expect-error test-only restore
  delete globalThis.fetch;
});

describe('fetchNotebook — the one read path for a placed notebook-backed component', () => {
  test('reads the workspace off the pad URL and rides params on the query string', async () => {
    setPath('/w/ws_1/canvas/cv_1/pad');
    let seenUrl = '';
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ rows: [{ title: 'obs', priority: 3 }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const rows = await fetchNotebook('open_problems', { status: 'open', limit: 5 });
    expect(seenUrl).toBe('/api/workspaces/ws_1/notebook/open_problems?status=open&limit=5');
    expect(rows).toEqual([{ title: 'obs', priority: 3 }]);
  });

  test('omits the query string entirely when there are no params', async () => {
    setPath('/w/ws_1/canvas/cv_1/pad');
    let seenUrl = '';
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchNotebook('recent_observations');
    expect(seenUrl).toBe('/api/workspaces/ws_1/notebook/recent_observations');
  });

  test('a non-ok response throws an agent-legible error naming the query and status', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchNotebook('unknown_query')).rejects.toThrow(/unknown_query.*404/);
  });
});
