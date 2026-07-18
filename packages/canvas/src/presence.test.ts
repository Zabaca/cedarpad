// #212 client side: remote presence entries become tldraw instance_presence records
// (self excluded, departures removed), and the heartbeat only sends on change or
// keepalive. The tldraw import needs a DOM at module-eval — harness first.
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import type { Editor } from 'tldraw';

import { applyPresence, entryToPresence, startPresenceHeartbeat, type PresenceEntry } from './presence';

function makeEditor() {
  const records = new Map<string, { id: string; typeName: string }>();
  const editor = {
    getCurrentPageId: () => 'page:main',
    inputs: { currentPagePoint: { x: 10.4, y: 20.6 } },
    getCamera: () => ({ x: 1, y: 2, z: 0.5 }),
    store: {
      allRecords: () => [...records.values()],
      put: (rs: Array<{ id: string; typeName: string }>) => rs.forEach((r) => records.set(r.id, r)),
      remove: (ids: string[]) => ids.forEach((id) => records.delete(id)),
      mergeRemoteChanges: (fn: () => void) => fn(),
    },
  };
  return { editor: editor as unknown as Editor, records };
}

const entry = (userId: string, over: Partial<PresenceEntry> = {}): PresenceEntry => ({
  userId,
  color: 'hsl(210 65% 52%)',
  cursor: { x: 1, y: 2 },
  camera: { x: 0, y: 0, z: 1 },
  ...over,
});

describe('entryToPresence', () => {
  test('maps the wire entry to a full instance_presence record', () => {
    const r = entryToPresence(entry('u1', { name: 'James' }), 'page:main', 123);
    expect(r.typeName).toBe('instance_presence');
    expect(r).toMatchObject({
      userId: 'u1',
      userName: 'James',
      color: 'hsl(210 65% 52%)',
      currentPageId: 'page:main',
      cursor: { x: 1, y: 2, type: 'default', rotation: 0 },
      camera: { x: 0, y: 0, z: 1 },
      lastActivityTimestamp: 123,
    });
  });

  test('a nameless guest renders as "Guest"; a parked cursor stays null', () => {
    const r = entryToPresence(entry('g1', { cursor: null }), 'page:main', 1);
    expect(r.userName).toBe('Guest');
    expect(r.cursor).toBeNull();
  });
});

describe('applyPresence', () => {
  test('upserts everyone but SELF; removes departed users on the next frame', () => {
    const { editor, records } = makeEditor();
    applyPresence(editor, [entry('me'), entry('u2'), entry('u3')], 'me', 1);
    expect([...records.keys()].sort()).toEqual(['instance_presence:u2', 'instance_presence:u3']);

    applyPresence(editor, [entry('me'), entry('u2')], 'me', 2); // u3 left
    expect([...records.keys()]).toEqual(['instance_presence:u2']);
  });

  test('an unchanged entry writes nothing (no put, no merge) until the re-stamp window lapses', () => {
    const { editor, records } = makeEditor();
    let puts = 0;
    const realPut = editor.store.put.bind(editor.store);
    editor.store.put = ((rs: never[]) => {
      puts += 1;
      realPut(rs);
    }) as typeof editor.store.put;

    applyPresence(editor, [entry('u2')], 'me', 1_000);
    expect(puts).toBe(1);
    // Identical frames inside the window: skipped entirely.
    applyPresence(editor, [entry('u2')], 'me', 1_100);
    applyPresence(editor, [entry('u2')], 'me', 2_000);
    expect(puts).toBe(1);
    // A moved cursor writes immediately…
    applyPresence(editor, [entry('u2', { cursor: { x: 9, y: 9 } })], 'me', 2_100);
    expect(puts).toBe(2);
    // …and a parked one re-stamps once its liveness window lapses.
    applyPresence(editor, [entry('u2', { cursor: { x: 9, y: 9 } })], 'me', 6_000);
    expect(puts).toBe(3);
    expect(records.size).toBe(1);
  });
});

describe('startPresenceHeartbeat', () => {
  test('beats carry identity + rounded cursor/camera; unchanged state is not re-sent inside the keepalive window', async () => {
    const { editor } = makeEditor();
    const sent: PresenceEntry[] = [];
    // currentUserSnapshot resolves to guest in this env (no auth endpoint) — wait for it.
    const stop = startPresenceHeartbeat(editor, (b) => sent.push(b));
    const deadline = Date.now() + 2000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const count = sent.length;
    await new Promise((r) => setTimeout(r, 400)); // several ticks, nothing moved
    stop();
    expect(sent.length).toBe(count); // change-gated: no re-send within keepalive
    expect(sent[0]).toMatchObject({
      cursor: { x: 10, y: 21 }, // rounded
      camera: { x: 1, y: 2, z: 0.5 },
    });
    expect(sent[0]?.userId).toMatch(/^guest_/);
  });
});
