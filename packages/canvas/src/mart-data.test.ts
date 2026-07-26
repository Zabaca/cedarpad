import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import { fetchMart } from './mart-data';

const setPath = (pathname: string) => {
  (globalThis as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`https://poc.cedarpad.com${pathname}`);
};

afterEach(() => {
  setPath('/');
  // @ts-expect-error test-only restore
  delete globalThis.fetch;
});

describe('fetchMart — the one read path for a placed mart-backed component', () => {
  test('reads the workspace off the pad URL and hits the mart route', async () => {
    setPath('/w/ws_1/canvas/cv_1/pad');
    let seenUrl = '';
    globalThis.fetch = (async (url: string) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({
          rows: [{ x: 1 }],
          sidecar: { name: 'mart_a', description: 'd', columns: [{ name: 'x', type: 'BIGINT', description: 'd' }], generatedAt: new Date().toISOString(), rowCount: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchMart('mart_a');
    expect(seenUrl).toBe('/api/workspaces/ws_1/marts/mart_a');
    expect(result.rows).toEqual([{ x: 1 }]);
    expect(result.sidecar.rowCount).toBe(1);
  });

  test('a non-ok response throws an agent-legible error', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchMart('mart_missing')).rejects.toThrow(/mart_missing/);
  });

  test('a malformed sidecar throws (re-validated at the boundary, not trusted blind)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ rows: [], sidecar: { name: 'x' } }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchMart('mart_bad')).rejects.toThrow();
  });
});
