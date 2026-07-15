// #212: the ephemeral per-canvas presence room. Staleness IS the disconnect
// signal — a closed tab stops beating and falls out of the snapshot.

import { describe, expect, test } from 'bun:test';

import { createPresenceRoom, parseHeartbeat } from './presence.ts';

describe('presence room', () => {
  test('beats merge by userId; snapshot returns the live set', () => {
    const room = createPresenceRoom(() => 1000);
    room.beat({ userId: 'u1', name: 'James', color: 'red', cursor: { x: 1, y: 2 }, camera: null });
    room.beat({ userId: 'u2', color: 'blue', cursor: null, camera: { x: 0, y: 0, z: 1 } });
    room.beat({ userId: 'u1', name: 'James', color: 'red', cursor: { x: 9, y: 9 }, camera: null }); // update, not dup
    const snap = room.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.find((e) => e.userId === 'u1')?.cursor).toEqual({ x: 9, y: 9 });
  });

  test('a stale entry (no beat for 10s) drops out; a fresh one stays', () => {
    let t = 0;
    const room = createPresenceRoom(() => t);
    room.beat({ userId: 'gone', color: 'red', cursor: null, camera: null });
    t = 9_000;
    room.beat({ userId: 'here', color: 'blue', cursor: null, camera: null });
    t = 12_000; // 'gone' is 12s old, 'here' 3s
    expect(room.snapshot().map((e) => e.userId)).toEqual(['here']);
  });
});

describe('parseHeartbeat', () => {
  test('accepts a full beat and a minimal one; strips junk fields', () => {
    expect(
      parseHeartbeat({ userId: 'u1', name: 'J', color: 'red', cursor: { x: 1, y: 2 }, camera: { x: 0, y: 0, z: 1 }, junk: true }),
    ).toEqual({ userId: 'u1', name: 'J', color: 'red', cursor: { x: 1, y: 2 }, camera: { x: 0, y: 0, z: 1 } });
    expect(parseHeartbeat({ userId: 'u1', color: 'red' })).toEqual({ userId: 'u1', color: 'red', cursor: null, camera: null });
  });

  test('rejects malformed beats (no userId / no color / not an object)', () => {
    expect(parseHeartbeat(null)).toBeNull();
    expect(parseHeartbeat({ color: 'red' })).toBeNull();
    expect(parseHeartbeat({ userId: '', color: 'red' })).toBeNull();
    expect(parseHeartbeat({ userId: 'u1' })).toBeNull();
  });

  test('a camera missing z degrades to null camera, not an error', () => {
    expect(parseHeartbeat({ userId: 'u1', color: 'red', camera: { x: 1, y: 2 } })?.camera).toBeNull();
  });
});
