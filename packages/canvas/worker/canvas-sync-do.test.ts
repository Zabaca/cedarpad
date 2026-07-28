// The Durable Object's own half of revocation (#320 §5). The room itself is exercised in
// `sync-guest-write.test.ts`; what is pinned here is WHICH open sockets a revoked link
// takes down with it — the selection, which is where a mistake would either leave the
// revoked guest connected or disconnect innocent members.
import { describe, expect, test } from 'bun:test';

import { socketsForLink } from './canvas-sync-do.ts';

/** A hibernation socket is only ever read through its attachment; that is all this needs. */
const socket = (attachment: unknown) => ({ deserializeAttachment: () => attachment }) as unknown as WebSocket;

const guest = (sessionId: string, linkId: string) => socket({ sessionId, linkId, meta: { userId: `guest:${sessionId}` } });
const member = (sessionId: string) => socket({ sessionId, meta: { userId: 'u_1' } });

describe('socketsForLink', () => {
  test("takes every connection the revoked link opened — including a second guest on the same link", () => {
    const a = guest('s1', 'sl_1');
    const b = guest('s2', 'sl_1');
    const other = guest('s3', 'sl_2');
    const mine = member('s4');
    expect(socketsForLink([a, b, other, mine], 'sl_1')).toEqual([a, b]);
  });

  test('a member connection is never selected — it carries no link at all', () => {
    expect(socketsForLink([member('s4')], 'sl_1')).toEqual([]);
    // …and neither is a socket whose attachment never arrived (a wake mid-flight).
    expect(socketsForLink([socket(null)], 'sl_1')).toEqual([]);
  });
});
