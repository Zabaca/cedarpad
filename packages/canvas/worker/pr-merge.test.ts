import { describe, expect, test } from 'bun:test';

import { mergePullRequest } from './pr-merge.ts';

// The GitHub half of the Inbox merge (CONTEXT.md "Open PR"): squash-merge one PR with a
// repo-scoped installation token. `fetch` is injected, so this is the whole surface — what
// request goes out, and how each of GitHub's answers is read back.

const recorder = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const PR = 'https://github.com/Zabaca/cedarpad/pull/283';

describe('mergePullRequest', () => {
  test('squash-merges the PR the url names, authenticated with the given token', async () => {
    const { calls, fetchImpl } = recorder(200, { merged: true, sha: 'abc123' });

    const result = await mergePullRequest({ prUrl: PR, token: 'ghs_minted', fetchImpl });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    // The url is derived from the PR link, not assembled from anything the caller passed.
    expect(calls[0]?.url).toBe('https://api.github.com/repos/Zabaca/cedarpad/pulls/283/merge');
    expect(calls[0]?.init.method).toBe('PUT');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_minted');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ merge_method: 'squash' });
  });

  test('a url that is not a GitHub PR never reaches the network', async () => {
    const { calls, fetchImpl } = recorder(200, { merged: true });

    const result = await mergePullRequest({ prUrl: 'https://evil.example.com/a/b/pull/1', token: 't', fetchImpl });

    expect(result).toEqual({ ok: false, alreadyMerged: false, reason: 'Not a GitHub pull-request url.' });
    expect(calls).toEqual([]);
  });

  // 405 is what GitHub answers for "not mergeable" — conflicts, a failing required check, or
  // branch protection. Its own message is the useful part, so it is passed through verbatim.
  test('a refusal surfaces GitHub‘s own reason', async () => {
    const { fetchImpl } = recorder(405, { message: 'Pull Request is not mergeable' });

    expect(await mergePullRequest({ prUrl: PR, token: 't', fetchImpl })).toEqual({
      ok: false,
      alreadyMerged: false,
      reason: 'Pull Request is not mergeable',
    });
  });

  test('a PR already merged on github.com is reported as merged, not as a failure', async () => {
    // GitHub 405s a merged PR too, with this distinct message.
    const { fetchImpl } = recorder(405, { message: 'Pull Request is not mergeable: it was already merged' });

    expect(await mergePullRequest({ prUrl: PR, token: 't', fetchImpl })).toMatchObject({ alreadyMerged: true });
  });

  test('a body-less failure still yields a reason the Inbox can show', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    const result = await mergePullRequest({ prUrl: PR, token: 't', fetchImpl });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('500');
  });

  test('a network failure is a refusal, never a thrown turn', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    const result = await mergePullRequest({ prUrl: PR, token: 't', fetchImpl });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('connection reset');
  });
});
