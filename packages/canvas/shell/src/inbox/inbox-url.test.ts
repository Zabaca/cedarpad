import { describe, expect, test } from 'bun:test';
import { inboxStateFromUrl, urlWithInboxState } from './inbox-url';

// The Inbox's URL-persisted state (view + selection — no workspace filter anymore: the
// Inbox is scoped server-side to the active workspace, worker/inbox.ts).

describe('inboxStateFromUrl', () => {
  test('defaults to "open" and no selected conversation', () => {
    expect(inboxStateFromUrl('')).toEqual({ view: 'open', conv: null });
  });

  test('reads an explicit view + conv', () => {
    expect(inboxStateFromUrl('?view=all&conv=c1')).toEqual({ view: 'all', conv: 'c1' });
    expect(inboxStateFromUrl('?view=closed')).toEqual({ view: 'closed', conv: null });
  });

  test('an unknown view falls back to "open"', () => {
    expect(inboxStateFromUrl('?view=bogus')).toEqual({ view: 'open', conv: null });
  });

  test('a legacy ?view=needs-me URL (the retired view) falls back to "open"', () => {
    expect(inboxStateFromUrl('?view=needs-me')).toEqual({ view: 'open', conv: null });
  });
});

describe('urlWithInboxState', () => {
  test('omits view when it is the default (open) and conv when unset', () => {
    expect(urlWithInboxState('', { view: 'open', conv: null })).toBe('');
  });

  test('sets view and conv when non-default/present, preserving other params', () => {
    expect(urlWithInboxState('?stage=inbox', { view: 'all', conv: 'c1' })).toBe('?stage=inbox&view=all&conv=c1');
  });

  test('clears a previously-set view/conv when they return to default/unset', () => {
    expect(urlWithInboxState('?stage=inbox&view=all&conv=c1', { view: 'open', conv: null })).toBe('?stage=inbox');
  });
});
