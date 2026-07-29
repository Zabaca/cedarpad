import { describe, expect, mock, test } from 'bun:test';
import { refuseEmptyTarball, tarEntries, tarHasContent } from './persist-guards.ts';

// Build a POSIX tar in-memory so the tests exercise the real header parser rather than a
// stub. `type` '5' is a directory, '0' a regular file.
function tar(entries: Array<{ name: string; body?: string; type?: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const body = new TextEncoder().encode(e.body ?? '');
    const h = new Uint8Array(512);
    h.set(new TextEncoder().encode(e.name).slice(0, 100), 0);
    h.set(new TextEncoder().encode(body.length.toString(8).padStart(11, '0') + '\0'), 124);
    h.set(new TextEncoder().encode(e.type ?? '0'), 156);
    blocks.push(h);
    if (body.length) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

describe('tarEntries', () => {
  test('reads names, sizes and typeflags; stops at the end block', () => {
    const bytes = tar([
      { name: 'canvas-default/components/', type: '5' },
      { name: 'canvas-default/components/KpiCard.tsx', body: 'export default 1' },
    ]);
    expect(tarEntries(bytes)).toEqual([
      { name: 'canvas-default/components/', size: 0, type: '5' },
      { name: 'canvas-default/components/KpiCard.tsx', size: 16, type: '0' },
    ]);
  });

  test('a truncated archive yields what it read, never throws — a guard must not be the reason a write fails', () => {
    const full = tar([{ name: 'a/X.tsx', body: 'x'.repeat(600) }]);
    expect(() => tarEntries(full.slice(0, 700))).not.toThrow();
    expect(tarEntries(full.slice(0, 700))[0]?.name).toBe('a/X.tsx');
  });

  test('garbage bytes do not throw', () => {
    expect(() => tarEntries(new Uint8Array(2048).fill(0xff))).not.toThrow();
  });
});

describe('tarHasContent', () => {
  test('an archive of only directories is empty — THE 2026-07-29 SHAPE', () => {
    // Exactly what was written over the good blob: three canvas dirs, zero files.
    const bytes = tar([
      { name: 'canvas-cv_4bfb07e3/', type: '5' },
      { name: 'canvas-cv_4bfb07e3/components', type: '5' },
      { name: 'canvas-cv_guestwrite/', type: '5' },
      { name: 'canvas-cv_guestwrite/components', type: '5' },
      { name: 'canvas-default/', type: '5' },
      { name: 'canvas-default/components', type: '5' },
    ]);
    expect(tarHasContent(bytes)).toBe(false);
  });

  test('placeholders alone are still empty', () => {
    expect(tarHasContent(tar([{ name: './', type: '5' }, { name: './.gitkeep' }]))).toBe(false);
  });

  test('one real file is content', () => {
    expect(tarHasContent(tar([{ name: './.gitkeep' }, { name: './Outliner.tsx', body: 'x' }]))).toBe(true);
  });

  test('a zero-byte real file still counts as content — emptiness is about the ARCHIVE, not the file', () => {
    expect(tarHasContent(tar([{ name: 'a/Empty.tsx', body: '' }]))).toBe(true);
  });
});

describe('refuseEmptyTarball', () => {
  const full = tar([{ name: 'a/X.tsx', body: 'source' }]);
  const empty = tar([{ name: 'a/', type: '5' }]);

  test('allows a normal write', async () => {
    const guard = refuseEmptyTarball('canvas-dirs', async () => true, () => {});
    expect(await guard(full)).toBe(true);
  });

  test('REFUSES an empty archive when a blob already exists', async () => {
    const logged: string[] = [];
    const guard = refuseEmptyTarball('canvas-dirs', async () => true, (m) => logged.push(m));
    expect(await guard(empty)).toBe(false);
    expect(logged[0]).toContain('REFUSED');
    expect(logged[0]).toContain('UNCHANGED');
  });

  test('allows an empty FIRST write — a new workspace has no components and nothing to lose', async () => {
    const guard = refuseEmptyTarball('canvas-dirs', async () => false, () => {});
    expect(await guard(empty)).toBe(true);
  });

  test('does not read the blob, only its existence (sessions.tar is ~49MB — a read per flush is not affordable)', async () => {
    const exists = mock(async () => true);
    const guard = refuseEmptyTarball('sessions', exists, () => {});
    await guard(full);
    // A non-empty archive short-circuits before even the existence check.
    expect(exists).toHaveBeenCalledTimes(0);
    await guard(empty);
    expect(exists).toHaveBeenCalledTimes(1);
  });
});
