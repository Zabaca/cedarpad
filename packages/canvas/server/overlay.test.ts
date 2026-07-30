import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listCanvasDirs, maxMtimeCanvasDirs, maxMtimeMs, tarCanvasDirs, tarSubtree } from './overlay.ts';

const mk = (suffix: string) => join(tmpdir(), `Tmp_OverlayTest_${process.pid}_${suffix}`);
const w = async (p: string, s: string) => {
  mkdirSync(join(p, '..'), { recursive: true });
  await Bun.write(p, s);
};

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
// The restore half went with the boot restore (#366) — nothing unpacks a content archive.
describe('canvas own dirs: what the dirty-check sees', () => {
  test('lists every canvas-<id> dir and excludes the platform base', async () => {
    const src = mk('cvsrc');
    try {
      await w(join(src, 'canvas-default/components/Card.tsx'), 'CARD');
      await w(join(src, 'canvas-cv_abc/components/Board.tsx'), 'BOARD');
      await w(join(src, 'canvas-components/Seed.tsx'), 'SEED'); // platform base
      await w(join(src, 'App.tsx'), 'APP'); // app code, not a canvas dir

      expect(await listCanvasDirs(src)).toEqual(['canvas-cv_abc', 'canvas-default']);
      expect((await tarCanvasDirs(src)).length).toBeGreaterThan(0);
    } finally {
      if (existsSync(src)) rmSync(src, { recursive: true, force: true });
    }
  });

  test('no canvas dirs → an empty (but valid) tar and a zero clock', async () => {
    const src = mk('cvempty');
    try {
      mkdirSync(src, { recursive: true });
      expect((await tarCanvasDirs(src)).length).toBeGreaterThan(0); // a valid empty archive
      expect(await maxMtimeCanvasDirs(src)).toBe(0);
    } finally {
      if (existsSync(src)) rmSync(src, { recursive: true, force: true });
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
