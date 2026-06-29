import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractOverlay, maxMtimeMs, tarSubtree } from './overlay.ts';

const mk = (suffix: string) => join(tmpdir(), `Tmp_OverlayTest_${process.pid}_${suffix}`);
const w = async (p: string, s: string) => {
  mkdirSync(join(p, '..'), { recursive: true });
  await Bun.write(p, s);
};

describe('overlay tar round-trip', () => {
  test('replaces the subtree: additions kept, excludes dropped, deletions+node_modules honored', async () => {
    const src = mk('src');
    const dst = mk('dst');
    try {
      // Source: two real files + an excluded node_modules entry.
      await w(join(src, 'a.txt'), 'A');
      await w(join(src, 'sub/b.txt'), 'B');
      await w(join(src, 'node_modules/dep.js'), 'NOPE');

      const bytes = await tarSubtree(src);

      // Destination pre-state: a stale file (must be wiped) and an image-resident
      // node_modules entry (must survive the wipe).
      await w(join(dst, 'stale.txt'), 'STALE');
      await w(join(dst, 'node_modules/keep.js'), 'KEEP');

      await extractOverlay(bytes, dst);

      expect(existsSync(join(dst, 'a.txt'))).toBe(true);
      expect(existsSync(join(dst, 'sub/b.txt'))).toBe(true);
      expect(existsSync(join(dst, 'node_modules/dep.js'))).toBe(false); // excluded from tar
      expect(existsSync(join(dst, 'stale.txt'))).toBe(false); // wiped (deletion honored)
      expect(existsSync(join(dst, 'node_modules/keep.js'))).toBe(true); // image-resident, preserved
    } finally {
      for (const d of [src, dst]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });
});

const setMtime = (p: string, ms: number) => utimes(p, ms / 1000, ms / 1000);

describe('maxMtimeMs (turn-completion dirty-check)', () => {
  test('D1 a dir with one file → that file mtime', async () => {
    const dir = join(tmpdir(), `Tmp_MaxMtime_one_${process.pid}`);
    try {
      mkdirSync(dir, { recursive: true });
      const f = join(dir, 'a.tsx');
      await writeFile(f, 'x');
      expect(await maxMtimeMs(dir)).toBe(statSync(f).mtimeMs);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D2 a newer file advances it; EXCLUDES dirs are ignored', async () => {
    const dir = join(tmpdir(), `Tmp_MaxMtime_adv_${process.pid}`);
    try {
      mkdirSync(dir, { recursive: true });
      const a = join(dir, 'a.tsx');
      await writeFile(a, 'x');
      await setMtime(a, 1_000_000_000_000);
      expect(await maxMtimeMs(dir)).toBe(1_000_000_000_000);

      // A far-newer file inside an excluded dir must NOT count.
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      const junk = join(dir, 'node_modules', 'big.js');
      await writeFile(junk, 'y');
      await setMtime(junk, 2_000_000_000_000);
      expect(await maxMtimeMs(dir)).toBe(1_000_000_000_000);

      // A newer real file advances it.
      const b = join(dir, 'b.tsx');
      await writeFile(b, 'z');
      await setMtime(b, 1_500_000_000_000);
      expect(await maxMtimeMs(dir)).toBe(1_500_000_000_000);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D3 empty or absent dir → 0', async () => {
    const empty = join(tmpdir(), `Tmp_MaxMtime_empty_${process.pid}`);
    try {
      mkdirSync(empty, { recursive: true });
      expect(await maxMtimeMs(empty)).toBe(0);
      expect(await maxMtimeMs(join(empty, 'does-not-exist'))).toBe(0);
    } finally {
      if (existsSync(empty)) rmSync(empty, { recursive: true, force: true });
    }
  });
});
