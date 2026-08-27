import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DATA_MAX_BYTES } from '../shared/bridge-wire.ts';
import { adoptSharedComponent, editComponent, isShared, listComponents, promoteComponent, readComponent, writeComponent, writeDataFile } from './components.ts';

const TMP = 'Tmp_ComponentsTest';
// ADR-0014: the default canvas owns src/canvas-default/components/ like every other
// canvas; src/canvas-components/ is the read-only platform base.
const tmpPath = fileURLToPath(new URL(`../src/canvas-default/components/${TMP}.tsx`, import.meta.url));
const cleanup = () => existsSync(tmpPath) && rmSync(tmpPath);

// A unique module name so the promote round-trip never collides with the seed library.
const SH = 'Tmp_SharedPromote';
const ownPath = fileURLToPath(new URL(`../src/canvas-default/components/${SH}.tsx`, import.meta.url));
const sharedPath = fileURLToPath(new URL(`../shared/components/${SH}.tsx`, import.meta.url));
const cleanupShared = () => {
  if (existsSync(ownPath)) rmSync(ownPath);
  if (existsSync(sharedPath)) rmSync(sharedPath);
};

describe('component file CRUD', () => {
  test('list includes the platform seed library — on EVERY canvas (ADR-0014)', async () => {
    const mods = await listComponents();
    expect(mods).toContain('MarkdownCard');
    expect(mods).toContain('ChartCard');
    // The MarkdownCard incident: a non-default canvas must see the platform tier too.
    expect(await listComponents('cv_somewhere_else')).toContain('MarkdownCard');
  });

  test('read returns source (platform base resolves for any canvas); missing throws', async () => {
    expect(await readComponent('MarkdownCard')).toContain('MarkdownCard');
    expect(await readComponent('MarkdownCard', 'cv_somewhere_else')).toContain('MarkdownCard');
    expect(readComponent('DefinitelyMissing')).rejects.toThrow(/does not exist/);
  });

  test('writing a platform module name shadows it into the canvas own dir — base stays untouched', async () => {
    const basePath = fileURLToPath(new URL('../src/canvas-components/MarkdownCard.tsx', import.meta.url));
    const shadowPath = fileURLToPath(new URL('../src/canvas-default/components/MarkdownCard.tsx', import.meta.url));
    const baseBefore = readFileSync(basePath, 'utf8');
    try {
      await writeComponent('MarkdownCard', 'export default () => <div>shadowed</div>;\n');
      expect(readFileSync(basePath, 'utf8')).toBe(baseBefore); // read-only tier
      expect(existsSync(shadowPath)).toBe(true);
      expect(await readComponent('MarkdownCard')).toContain('shadowed'); // own wins resolution
    } finally {
      if (existsSync(shadowPath)) rmSync(shadowPath);
    }
  });

  test('write then read round-trips; edit replaces a unique snippet', async () => {
    try {
      await writeComponent(TMP, 'export default () => <div>v1</div>;\n');
      expect(await readComponent(TMP)).toContain('v1');
      await editComponent(TMP, 'v1', 'v2');
      expect(await readComponent(TMP)).toContain('v2');
    } finally {
      cleanup();
    }
  });

  test('edit rejects a non-unique or missing old_string', async () => {
    try {
      await writeComponent(TMP, 'a a\n');
      expect(editComponent(TMP, 'a', 'b')).rejects.toThrow(/not unique/);
      expect(editComponent(TMP, 'zzz', 'b')).rejects.toThrow(/not found/);
    } finally {
      cleanup();
    }
  });

  test('rejects path-escaping / invalid names', async () => {
    expect(readComponent('../secret')).rejects.toThrow(/invalid component name/);
    expect(writeComponent('a/b', 'x')).rejects.toThrow(/invalid component name/);
  });
});

describe('data files: write_data lands next to components', () => {
  const DF = 'tmp_data_test.json';
  const dfOwn = fileURLToPath(new URL(`../src/canvas-default/components/${DF}`, import.meta.url));
  const dfShared = fileURLToPath(new URL(`../shared/components/${DF}`, import.meta.url));
  const cleanupData = () => {
    if (existsSync(dfOwn)) rmSync(dfOwn);
    if (existsSync(dfShared)) rmSync(dfShared);
  };

  test('writes into the canvas own dir; components can import it as a sibling', async () => {
    try {
      await writeDataFile(DF, '{"rows": [1, 2]}');
      expect(existsSync(dfOwn)).toBe(true);
      expect(readFileSync(dfOwn, 'utf8')).toContain('rows');
    } finally {
      cleanupData();
    }
  });

  test('rejects executable extensions, missing extension, and path escape', () => {
    expect(writeDataFile('evil.tsx', 'x')).rejects.toThrow(/invalid data file name/);
    expect(writeDataFile('evil.ts', 'x')).rejects.toThrow(/invalid data file name/);
    expect(writeDataFile('evil.js', 'x')).rejects.toThrow(/invalid data file name/);
    expect(writeDataFile('noext', 'x')).rejects.toThrow(/invalid data file name/);
    expect(writeDataFile('../escape.json', 'x')).rejects.toThrow(/invalid data file name/);
  });

  test('rejects malformed JSON for .json files (a broken import kills the component build)', () => {
    expect(writeDataFile(DF, '{nope')).rejects.toThrow(/not valid JSON/);
  });

  test('rejects content over the cap derived from what the store can hold', () => {
    expect(writeDataFile('big.txt', 'x'.repeat(DATA_MAX_BYTES + 1))).rejects.toThrow(/too large/);
  });

  test('a data file already in the shared lib stays the one shared source on overwrite', async () => {
    try {
      mkdirSync(fileURLToPath(new URL('../shared/components/', import.meta.url)), { recursive: true });
      writeFileSync(dfShared, '{"v": 1}');
      await writeDataFile(DF, '{"v": 2}');
      expect(readFileSync(dfShared, 'utf8')).toContain('"v": 2');
      expect(existsSync(dfOwn)).toBe(false);
    } finally {
      cleanupData();
    }
  });
});

describe('shared library: promote (move) + adopt (copy-back to diverge)', () => {
  test('promote moves the file own → shared; then it resolves as shared', async () => {
    try {
      await writeComponent(SH, 'export default () => <div>promote me</div>;\n');
      expect(existsSync(ownPath)).toBe(true);
      expect(await isShared(SH)).toBe(false);

      await promoteComponent('default', SH);
      expect(existsSync(ownPath)).toBe(false); // MOVED, not copied
      expect(existsSync(sharedPath)).toBe(true);
      expect(await isShared(SH)).toBe(true);
      // Reads span own + shared, so a canvas still sees the promoted module by bare name.
      expect(await readComponent(SH)).toContain('promote me');
      expect(await listComponents()).toContain(SH);
    } finally {
      cleanupShared();
    }
  });

  test('editing a promoted module writes back to the shared source (one live source)', async () => {
    try {
      await writeComponent(SH, 'export default () => <div>v1</div>;\n');
      await promoteComponent('default', SH);
      await editComponent(SH, 'v1', 'v2');
      expect(await readComponent(SH)).toContain('v2');
      expect(existsSync(ownPath)).toBe(false); // still only in shared
    } finally {
      cleanupShared();
    }
  });

  test('adopt copies a shared module back into the canvas own dir (diverge)', async () => {
    try {
      await writeComponent(SH, 'export default () => <div>base</div>;\n');
      await promoteComponent('default', SH);
      await adoptSharedComponent('default', SH);
      expect(existsSync(ownPath)).toBe(true); // own copy now wins own-first resolution
      expect(existsSync(sharedPath)).toBe(true);
    } finally {
      cleanupShared();
    }
  });

  test('promote rejects a missing own file and a name collision; preserves path-escape guard', async () => {
    await expect(promoteComponent('default', 'DefinitelyMissing')).rejects.toThrow(/not in canvas/);
    await expect(promoteComponent('default', '../secret')).rejects.toThrow(/invalid component name/);
    try {
      await writeComponent(SH, 'export default () => null;\n');
      await promoteComponent('default', SH);
      await adoptSharedComponent('default', SH); // canvas re-owns a copy (diverged): own + shared coexist
      await expect(promoteComponent('default', SH)).rejects.toThrow(/already exists/);
    } finally {
      cleanupShared();
    }
  });
});
