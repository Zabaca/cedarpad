import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCanvasDirs, extractOverlay, listCanvasDirs, maxMtimeCanvasDirs, maxMtimeMs, tarCanvasDirs, tarSubtree } from './overlay.ts';

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

// ADR-0014: the per-canvas component dirs travel as ONE tar (src-relative paths),
// with the read-only platform base (src/canvas-components/) never captured or wiped.
describe('canvas own dirs: tar + restore, platform base untouched', () => {
  test('round-trips every canvas-<id> dir; base dir excluded from capture AND wipe', async () => {
    const src = mk('cvsrc');
    const dst = mk('cvdst');
    try {
      await w(join(src, 'canvas-default/components/Card.tsx'), 'CARD');
      await w(join(src, 'canvas-cv_abc/components/Board.tsx'), 'BOARD');
      await w(join(src, 'canvas-components/Seed.tsx'), 'SEED'); // platform base
      await w(join(src, 'App.tsx'), 'APP'); // app code, not a canvas dir

      expect(await listCanvasDirs(src)).toEqual(['canvas-cv_abc', 'canvas-default']);
      const bytes = await tarCanvasDirs(src);

      await w(join(dst, 'canvas-stale/components/Old.tsx'), 'STALE'); // must be wiped
      await w(join(dst, 'canvas-components/Seed.tsx'), 'SEED-DST'); // must survive
      await extractCanvasDirs(bytes, dst);

      expect(existsSync(join(dst, 'canvas-default/components/Card.tsx'))).toBe(true);
      expect(existsSync(join(dst, 'canvas-cv_abc/components/Board.tsx'))).toBe(true);
      expect(existsSync(join(dst, 'canvas-stale'))).toBe(false); // deletion honored
      expect(await Bun.file(join(dst, 'canvas-components/Seed.tsx')).text()).toBe('SEED-DST');
    } finally {
      for (const d of [src, dst]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  test('no canvas dirs → an empty (but valid) tar; extract is a no-op wipe of nothing', async () => {
    const src = mk('cvempty');
    const dst = mk('cvempty_dst');
    try {
      mkdirSync(src, { recursive: true });
      mkdirSync(dst, { recursive: true });
      const bytes = await tarCanvasDirs(src);
      await extractCanvasDirs(bytes, dst); // must not throw
      expect(await maxMtimeCanvasDirs(src)).toBe(0);
    } finally {
      for (const d of [src, dst]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  test('maxMtimeCanvasDirs tracks the newest file across canvas dirs only', async () => {
    const src = mk('cvmtime');
    try {
      await w(join(src, 'canvas-default/components/A.tsx'), 'A');
      await w(join(src, 'canvas-components/Seed.tsx'), 'SEED');
      const t = await maxMtimeCanvasDirs(src);
      expect(t).toBeGreaterThan(0);
      expect(t).toBe(await maxMtimeMs(join(src, 'canvas-default')));
      // touching the BASE dir does not move the canvas-dirs clock
      await utimes(join(src, 'canvas-components/Seed.tsx'), new Date(), new Date(Date.now() + 60_000));
      expect(await maxMtimeCanvasDirs(src)).toBe(t);
    } finally {
      if (existsSync(src)) rmSync(src, { recursive: true, force: true });
    }
  });
});
