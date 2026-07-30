import { describe, expect, test } from 'bun:test';

import {
  InboxBadge,
  WorkspaceEvent,
  encodeInboxBadgeFrame,
  readInboxBadgeFrame,
  workspaceEventsName,
} from './workspace-events.ts';

// The one contract the workspace events hub speaks (CLAUDE.md §7), parsed on both sides:
// the notice a writer hands the hub, and the badge frame the hub's stream hands the Shell.

describe('WorkspaceEvent — the notice a writer hands the hub', () => {
  test('carries a topic and nothing else — the hub is a notifier, never a payload bus', () => {
    expect(WorkspaceEvent.parse({ topic: 'inbox' })).toEqual({ topic: 'inbox' });
  });

  test('refuses an unknown topic, and anything that is not an object', () => {
    expect(WorkspaceEvent.safeParse({ topic: 'presence' }).success).toBe(false);
    expect(WorkspaceEvent.safeParse('inbox').success).toBe(false);
    expect(WorkspaceEvent.safeParse(null).success).toBe(false);
  });

  // The hub holds NO inbox state (ADR-0022) — so a count must not even be expressible on
  // the wire. If it were, someone would eventually put one there.
  test('a count cannot ride the notice — an extra field is stripped, never carried', () => {
    expect(WorkspaceEvent.parse({ topic: 'inbox', count: 7 })).toEqual({ topic: 'inbox' });
  });
});

describe('InboxBadge — the SSE frame the Shell renders', () => {
  // `EventSource` hands the handler the DATA payload, already stripped of the `data: `
  // prefix and the blank line — so the round trip is over that, not over the raw frame.
  const payloadOf = (frame: string) => frame.replace(/^data: /, '').trimEnd();

  test('round-trips through the frame encoding', () => {
    expect(readInboxBadgeFrame(payloadOf(encodeInboxBadgeFrame({ count: 3, readAt: 1234 })))).toEqual({
      count: 3,
      readAt: 1234,
    });
  });

  test('the encoded frame is SSE-shaped: a data line and a blank line', () => {
    expect(encodeInboxBadgeFrame({ count: 0, readAt: 0 })).toBe('data: {"count":0,"readAt":0}\n\n');
  });

  test('a malformed frame reads as null rather than throwing at the receiver', () => {
    expect(readInboxBadgeFrame('not json')).toBeNull();
    expect(readInboxBadgeFrame('{"count":"three","readAt":0}')).toBeNull();
    expect(readInboxBadgeFrame('{"readAt":0}')).toBeNull();
  });

  test('rejects a negative count — a badge is a tally, and a wrong one is worse than none', () => {
    expect(InboxBadge.safeParse({ count: -1, readAt: 0 }).success).toBe(false);
  });
});

describe('workspaceEventsName', () => {
  test('addresses one hub per workspace, namespaced and traceable back to its workspace', () => {
    expect(workspaceEventsName('ws_1')).toBe('workspace-events:ws_1');
    expect(workspaceEventsName('ws_2')).not.toBe(workspaceEventsName('ws_1'));
  });
});
