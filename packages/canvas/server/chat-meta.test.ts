import { describe, expect, test } from 'bun:test';

import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../shared/chat-store.ts';
import { type BlobBackend, BlobStore, chatMetaKey, memBackend } from './blob-store.ts';
import { ChatMetaStore } from './chat-meta.ts';
import { PersistSink } from './persistable.ts';

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
      list: async () => [],
    };
    const s = new ChatMetaStore(new BlobStore(broken), 'ws1');
    expect(s.load()).rejects.toThrow(/backend down/);
  });
});

describe('ChatMetaStore.persistable — participates in the ADR-0003 sink', () => {
  test('M6 flushing the sink persists the map and records ok health', async () => {
    const backend = memBackend();
    const store = new ChatMetaStore(new BlobStore(backend), 'ws1');
    await store.load();
    store.set('c1', { model: 'opus' });

    const sink = new PersistSink();
    sink.register(store.persistable());
    await sink.flush('chatMeta');

    // Persisted: a fresh store loads it back through the same backend.
    const reloaded = new ChatMetaStore(new BlobStore(backend), 'ws1');
    await reloaded.load();
    expect(reloaded.get('c1').model).toBe('opus');

    // And the save is now visible in the sink's health (the win over the ad-hoc save().catch).
    expect(sink.healthSnapshot().find((h) => h.name === 'chatMeta')?.lastResult).toBe('ok');
  });

  test('M7 a backend save failure is recorded as failed health, not thrown', async () => {
    const broken: BlobBackend = { get: async () => null, put: async () => { throw new Error('put down'); }, exists: async () => false, list: async () => [] };
    const store = new ChatMetaStore(new BlobStore(broken), 'ws1');
    await store.load();
    store.set('c1', { model: 'opus' });

    const sink = new PersistSink();
    sink.register(store.persistable());
    await sink.flush('chatMeta'); // must NOT throw — the sink swallows + records

    const h = sink.healthSnapshot().find((x) => x.name === 'chatMeta');
    expect(h?.lastResult).toBe('failed');
    expect(h?.lastError).toMatch(/put down/);
  });
});
