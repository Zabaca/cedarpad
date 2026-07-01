import { describe, expect, test } from 'bun:test';

import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../src/chat-store.ts';
import { type BlobBackend, BlobStore, chatMetaKey, memBackend } from './blob-store.ts';
import { ChatMetaStore } from './chat-meta.ts';

const defaults = { sessionId: null, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, forkNext: false };

describe('chatMetaKey', () => {
  test('M1 chatMetaKey', () => {
    expect(chatMetaKey('ws1')).toEqual('workspaces/ws1/chat-meta.json');
  });
});

describe('ChatMetaStore', () => {
  test('M2 set merges; get returns it; round-trips through the backend', async () => {
    const backend = memBackend();
    const a = new ChatMetaStore(new BlobStore(backend), 'ws1');
    await a.load();
    a.set('c1', { model: 'opus' });
    a.set('c1', { sessionId: 's1' }); // merge, not replace
    await a.save();
    expect(a.get('c1')).toEqual({ sessionId: 's1', model: 'opus', effort: DEFAULT_EFFORT, forkNext: false });

    const b = new ChatMetaStore(new BlobStore(backend), 'ws1');
    await b.load();
    expect(b.get('c1')).toEqual({ sessionId: 's1', model: 'opus', effort: DEFAULT_EFFORT, forkNext: false });
  });

  test('M3 get for an unknown chat returns defaults', async () => {
    const s = new ChatMetaStore(new BlobStore(memBackend()), 'ws1');
    await s.load();
    expect(s.get('never-seen')).toEqual(defaults);
  });

  test('M4 consumeFork returns forkNext and clears it (one-shot)', async () => {
    const s = new ChatMetaStore(new BlobStore(memBackend()), 'ws1');
    await s.load();
    s.set('c1', { forkNext: true });
    expect(s.consumeFork('c1')).toBe(true);
    expect(s.consumeFork('c1')).toBe(false); // cleared
    expect(s.get('c1').forkNext).toBe(false);
  });

  test('M5 load from an absent key → empty map (clean)', async () => {
    const s = new ChatMetaStore(new BlobStore(memBackend()), 'ws1');
    await s.load();
    expect(s.get('anything')).toEqual(defaults);
  });

  test('M5b a backend error on load propagates', async () => {
    const broken: BlobBackend = {
      get: () => {
        throw new Error('backend down');
      },
      put: async () => {},
      exists: async () => false,
    };
    const s = new ChatMetaStore(new BlobStore(broken), 'ws1');
    expect(s.load()).rejects.toThrow(/backend down/);
  });
});
