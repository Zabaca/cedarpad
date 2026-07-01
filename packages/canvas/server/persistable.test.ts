import { describe, expect, test } from 'bun:test';

import { type Persistable, PersistSink } from './persistable.ts';

const ok = (name: string, save: () => Promise<void>, guard?: (v: number) => boolean): Persistable<number> => ({
  name,
  serialize: () => 1,
  save,
  ...(guard ? { guard } : {}),
});

describe('PersistSink', () => {
  test('P1 a resolving save records ok + savedAt, pending false', async () => {
    let saved = 0;
    const sink = new PersistSink();
    sink.register(ok('canvas', async () => void (saved += 1)));
    await sink.flush('canvas');
    const h = sink.healthSnapshot().find((x) => x.name === 'canvas')!;
    expect(saved).toBe(1);
    expect(h.lastResult).toBe('ok');
    expect(h.pending).toBe(false);
    expect(typeof h.savedAt).toBe('number');
    expect(h.lastError).toBeNull();
  });

  test('P2 a throwing save records failed + lastError, pending false', async () => {
    const sink = new PersistSink();
    sink.register(ok('sessions', async () => {
      throw new Error('R2 down');
    }));
    await sink.flush('sessions');
    const h = sink.healthSnapshot().find((x) => x.name === 'sessions')!;
    expect(h.lastResult).toBe('failed');
    expect(h.lastError).toMatch(/R2 down/);
    expect(h.pending).toBe(false);
  });

  test('P3 a guard returning false records skipped; save not called', async () => {
    let saved = 0;
    const sink = new PersistSink();
    sink.register(ok('components', async () => void (saved += 1), () => false));
    await sink.flush('components');
    const h = sink.healthSnapshot().find((x) => x.name === 'components')!;
    expect(saved).toBe(0);
    expect(h.lastResult).toBe('skipped');
    expect(h.pending).toBe(false);
  });

  test('P4 healthSnapshot returns every registered artifact (none = never flushed)', async () => {
    const sink = new PersistSink();
    sink.register(ok('canvas', async () => {}));
    sink.register(ok('components', async () => {}));
    sink.register(ok('custom', async () => {}));
    sink.register(ok('sessions', async () => {}));
    expect(sink.healthSnapshot().map((h) => h.name).sort()).toEqual(['canvas', 'components', 'custom', 'sessions']);
    expect(sink.healthSnapshot().every((h) => h.lastResult === 'none' && !h.pending)).toBe(true);
  });
});
