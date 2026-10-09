// The bridge→browser SSE plane, and specifically WHO each frame reaches.
//
// `screenshot` asks a question about the canvas and any browser may answer it. `page`
// moves ONE person's screen, and everything interesting here is about the ways that must
// fail closed: a canvas is a shared surface, and moving a colleague's view because someone
// else's agent asked is an act they never agreed to.

import { describe, expect, test } from 'bun:test';

import { createScreenshotChannel, type CanvasSubscriber } from './screenshot-channel.ts';

const dec = new TextDecoder();

/** A fake subscriber that records the frames it was handed. */
function sub(viewer: string | null): CanvasSubscriber & { frames: string[] } {
  const frames: string[] = [];
  return { viewer, frames, controller: { enqueue: (b: Uint8Array) => frames.push(dec.decode(b)) } as unknown as ReadableStreamDefaultController };
}

describe('selectPage targeting', () => {
  test('moves only the matching viewer, leaving everyone else where they were', () => {
    const ch = createScreenshotChannel('c1');
    const alice = sub('user_alice');
    const bob = sub('user_bob');
    const guest = sub(null);
    for (const s of [alice, bob, guest]) ch.clients.add(s);

    expect(ch.selectPage('page:two', 'user_alice')).toBe(1);

    expect(alice.frames).toHaveLength(1);
    expect(alice.frames[0]).toContain('event: page');
    expect(alice.frames[0]).toContain('page:two');
    expect(bob.frames).toEqual([]);
    expect(guest.frames).toEqual([]);
  });

  test('moves ALL of one viewer\'s tabs — a person with two windows open is still one person', () => {
    const ch = createScreenshotChannel('c1');
    const tab1 = sub('user_alice');
    const tab2 = sub('user_alice');
    ch.clients.add(tab1);
    ch.clients.add(tab2);
    expect(ch.selectPage('page:two', 'user_alice')).toBe(2);
  });

  // The fail-closed rule, in the direction that matters most: absent identity is never a
  // wildcard. A cron kick or a guest send reaching this must move NOBODY, not everybody.
  test('a null viewer targets nobody rather than everybody', () => {
    const ch = createScreenshotChannel('c1');
    const alice = sub('user_alice');
    const guest = sub(null);
    ch.clients.add(alice);
    ch.clients.add(guest);

    expect(ch.selectPage('page:two', null)).toBe(0);
    expect(alice.frames).toEqual([]);
    // ...including the unidentified subscriber itself: null must not match null.
    expect(guest.frames).toEqual([]);
  });

  test('a viewer with no tab open here reports 0 rather than silently succeeding', () => {
    const ch = createScreenshotChannel('c1');
    ch.clients.add(sub('user_bob'));
    expect(ch.selectPage('page:two', 'user_alice')).toBe(0);
  });

  test('a dead stream is dropped from the set instead of failing the fan-out', () => {
    const ch = createScreenshotChannel('c1');
    const dead: CanvasSubscriber = {
      viewer: 'user_alice',
      controller: { enqueue: () => { throw new Error('stream closed'); } } as unknown as ReadableStreamDefaultController,
    };
    const live = sub('user_alice');
    ch.clients.add(dead);
    ch.clients.add(live);

    expect(ch.selectPage('page:two', 'user_alice')).toBe(1);
    expect(ch.clients.has(dead)).toBe(false);
    expect(ch.clients.has(live)).toBe(true);
  });
});

describe('screenshot stays canvas-wide', () => {
  // The two frames answer different questions, and adding identity to the channel must not
  // have narrowed this one: a screenshot is about the CANVAS, and the first browser to
  // answer resolves it.
  test('asks every subscriber regardless of who they are', () => {
    const ch = createScreenshotChannel('c1');
    const alice = sub('user_alice');
    const guest = sub(null);
    ch.clients.add(alice);
    ch.clients.add(guest);

    void ch.requestScreenshot(10);
    expect(alice.frames[0]).toContain('event: screenshot');
    expect(guest.frames[0]).toContain('event: screenshot');
  });

  test('a named page rides the frame, so whichever tab answers renders the same page', () => {
    const ch = createScreenshotChannel('c1');
    const alice = sub('user_alice');
    ch.clients.add(alice);

    void ch.requestScreenshot(10, 'page:two');
    expect(alice.frames[0]).toContain('"pageId":"page:two"');
  });

  test('resolves null when nobody is connected', async () => {
    expect(await createScreenshotChannel('c1').requestScreenshot(10)).toBeNull();
  });
});
