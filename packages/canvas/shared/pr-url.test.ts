import { describe, expect, test } from 'bun:test';

import { parsePrUrl } from './pr-url.ts';

// The one place a PR url is turned into GitHub coordinates. Both ends depend on it: the
// platform RPC refuses a url this cannot read (parse at the boundary, CLAUDE.md §7), and the
// edge merge route addresses `/repos/:owner/:repo/pulls/:number/merge` from what it returns.

describe('parsePrUrl', () => {
  test('reads owner, repo and number from a PR url the dev-agent opened', () => {
    // The worked example: the PR in the ticket's screenshot.
    expect(parsePrUrl('https://github.com/Zabaca/cedarpad/pull/283')).toEqual({
      owner: 'Zabaca',
      repo: 'cedarpad',
      number: 283,
    });
  });

  test('tolerates the tab suffixes GitHub appends when you copy from the browser', () => {
    expect(parsePrUrl('https://github.com/Zabaca/cedarpad/pull/283/files')).toEqual({
      owner: 'Zabaca',
      repo: 'cedarpad',
      number: 283,
    });
  });

  test('refuses anything that is not a github.com pull request', () => {
    for (const bad of [
      'not-a-url',
      '',
      'https://github.com/Zabaca/cedarpad', // the repo, not a PR
      'https://github.com/Zabaca/cedarpad/issues/283', // an issue, not a PR
      'https://github.com/Zabaca/cedarpad/pull/abc', // no number
      'https://evil.example.com/Zabaca/cedarpad/pull/283', // not GitHub
      'http://github.com/Zabaca/cedarpad/pull/283', // not https
    ]) {
      expect(parsePrUrl(bad)).toBeNull();
    }
  });
});
