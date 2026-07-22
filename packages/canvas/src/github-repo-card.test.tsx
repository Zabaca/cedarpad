// GithubRepoCard behavior: live cloned-ness from the workspace repo set; one Clone button
// whose outcome the API decides (owner clones, member's 403 becomes a request stamp).
// Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import GithubRepoCard, { repoSetFromStatus } from './canvas-components/GithubRepoCard';

const render = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return host;
};

const flush = async () => {
  // let the mount-effect fetch chain settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** Fetch stub: /api/canvases → ws_1; the github status carries `set`; POSTs scripted. */
function stubFetch(opts: { set?: string[]; cloneStatus?: number; cloneBody?: unknown }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/canvases') return Response.json({ workspaceId: 'ws_1', canvases: [] });
    if (url === '/api/workspaces/ws_1/github') {
      return Response.json({ connected: true, selectedRepos: opts.set ?? [], patRepos: [], publicRepos: [] });
    }
    if (url === '/api/workspaces/ws_1/github/public') {
      return Response.json(opts.cloneBody ?? {}, { status: opts.cloneStatus ?? 200 });
    }
    if (url === '/api/workspaces/ws_1/github/refresh') return Response.json({ refreshed: ['x'], failed: [] });
    return new Response('stub 404', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('repoSetFromStatus', () => {
  test('flattens installation, PAT, and public repos into one membership set', () => {
    expect(
      repoSetFromStatus({ selectedRepos: ['a/b'], patRepos: [{ fullName: 'c/d' }], publicRepos: [{ fullName: 'e/f' }] }),
    ).toEqual(['a/b', 'c/d', 'e/f']);
  });
});

describe('GithubRepoCard', () => {
  test('a repo already in the workspace set shows cloned + its checkout path', async () => {
    const { fetchImpl } = stubFetch({ set: ['vercel/next.js'] });
    const host = render(<GithubRepoCard repo="vercel/next.js" url="https://github.com/vercel/next.js" fetchImpl={fetchImpl} />);
    await flush();
    expect(host.textContent).toContain('cloned');
    expect(host.textContent).toContain('.repos/vercel__next.js/');
    expect(host.textContent).toContain('Refresh checkout');
  });

  test('an unknown repo shows "not cloned"; a successful Clone flips it to cloned', async () => {
    const { fetchImpl, calls } = stubFetch({ set: [], cloneStatus: 200, cloneBody: { fullName: 'a/b' } });
    const host = render(<GithubRepoCard repo="a/b" url="https://github.com/a/b" fetchImpl={fetchImpl} />);
    await flush();
    expect(host.textContent).toContain('not cloned');

    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Clone'));
    await act(async () => {
      button!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/github/public'))).toBe(true);
    expect(host.textContent).toContain('.repos/a__b/');
  });

  test("a member's Clone (403) stamps requestedBy via setData — the click is the request", async () => {
    const { fetchImpl } = stubFetch({ set: [], cloneStatus: 403, cloneBody: { error: 'owner only' } });
    const patches: Record<string, unknown>[] = [];
    const host = render(
      <GithubRepoCard
        repo="a/b"
        url="https://github.com/a/b"
        fetchImpl={fetchImpl}
        setData={(p) => patches.push(p)}
        currentUser={{ id: 'u2', name: 'Khoa' }}
      />,
    );
    await flush();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Clone'));
    await act(async () => {
      button!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(patches).toEqual([{ requestedBy: 'Khoa' }]);
  });

  test('a private/missing repo surfaces the API error inline; the request stamp renders', async () => {
    const { fetchImpl } = stubFetch({ set: [], cloneStatus: 400, cloneBody: { error: 'x/y is not a public repo (private, missing, or unreachable)' } });
    const host = render(<GithubRepoCard repo="x/y" url="https://github.com/x/y" requestedBy="Khoa" fetchImpl={fetchImpl} />);
    await flush();
    expect(host.textContent).toContain('Clone requested by Khoa');
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Clone'));
    await act(async () => {
      button!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.textContent).toContain('not a public repo');
  });
});
