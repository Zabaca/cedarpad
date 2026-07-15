import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { adoptSharedComponent, editComponent, isShared, listComponents, promoteComponent, readComponent, writeComponent, writeDataFile } from './components.ts';

const TMP = 'Tmp_ComponentsTest';
const tmpPath = fileURLToPath(new URL(`../src/canvas-components/${TMP}.tsx`, import.meta.url));
const cleanup = () => existsSync(tmpPath) && rmSync(tmpPath);

// A unique module name so the promote round-trip never collides with the seed library.
const SH = 'Tmp_SharedPromote';
const ownPath = fileURLToPath(new URL(`../src/canvas-components/${SH}.tsx`, import.meta.url));
const sharedPath = fileURLToPath(new URL(`../shared/components/${SH}.tsx`, import.meta.url));
const cleanupShared = () => {
  if (existsSync(ownPath)) rmSync(ownPath);
  if (existsSync(sharedPath)) rmSync(sharedPath);
};

describe('component file CRUD', () => {
  test('list includes the seed library', () => {
    const mods = listComponents();
    expect(mods).toContain('KpiCard');
    expect(mods).toContain('Dashboard');
  });

  test('read returns source; missing throws', () => {
    expect(readComponent('KpiCard')).toContain('KpiCard');
    expect(() => readComponent('DefinitelyMissing')).toThrow(/does not exist/);
  });

  test('write then read round-trips; edit replaces a unique snippet', () => {
    try {
      writeComponent(TMP, 'export default () => <div>v1</div>;\n');
      expect(readComponent(TMP)).toContain('v1');
      editComponent(TMP, 'v1', 'v2');
      expect(readComponent(TMP)).toContain('v2');
    } finally {
      cleanup();
    }
  });

  test('edit rejects a non-unique or missing old_string', () => {
    try {
      writeComponent(TMP, 'a a\n');
      expect(() => editComponent(TMP, 'a', 'b')).toThrow(/not unique/);
      expect(() => editComponent(TMP, 'zzz', 'b')).toThrow(/not found/);
    } finally {
      cleanup();
    }
  });

  test('rejects path-escaping / invalid names', () => {
    expect(() => readComponent('../secret')).toThrow(/invalid component name/);
    expect(() => writeComponent('a/b', 'x')).toThrow(/invalid component name/);
  });
});

describe('data files: write_data lands next to components', () => {
  const DF = 'tmp_data_test.json';
  const dfOwn = fileURLToPath(new URL(`../src/canvas-components/${DF}`, import.meta.url));
  const dfShared = fileURLToPath(new URL(`../shared/components/${DF}`, import.meta.url));
  const cleanupData = () => {
    if (existsSync(dfOwn)) rmSync(dfOwn);
    if (existsSync(dfShared)) rmSync(dfShared);
  };

  test('writes into the canvas own dir; components can import it as a sibling', () => {
    try {
      writeDataFile(DF, '{"rows": [1, 2]}');
      expect(existsSync(dfOwn)).toBe(true);
      expect(readFileSync(dfOwn, 'utf8')).toContain('rows');
    } finally {
      cleanupData();
    }
  });

  test('rejects executable extensions, missing extension, and path escape', () => {
    expect(() => writeDataFile('evil.tsx', 'x')).toThrow(/invalid data file name/);
    expect(() => writeDataFile('evil.ts', 'x')).toThrow(/invalid data file name/);
    expect(() => writeDataFile('evil.js', 'x')).toThrow(/invalid data file name/);
    expect(() => writeDataFile('noext', 'x')).toThrow(/invalid data file name/);
    expect(() => writeDataFile('../escape.json', 'x')).toThrow(/invalid data file name/);
  });

  test('rejects malformed JSON for .json files (a broken import kills the component build)', () => {
    expect(() => writeDataFile(DF, '{nope')).toThrow(/not valid JSON/);
  });

  test('rejects content over the 1MB cap', () => {
    expect(() => writeDataFile('big.txt', 'x'.repeat(1_048_577))).toThrow(/too large/);
  });

  test('a data file already in the shared lib stays the one shared source on overwrite', () => {
    try {
      mkdirSync(fileURLToPath(new URL('../shared/components/', import.meta.url)), { recursive: true });
      writeFileSync(dfShared, '{"v": 1}');
      writeDataFile(DF, '{"v": 2}');
      expect(readFileSync(dfShared, 'utf8')).toContain('"v": 2');
      expect(existsSync(dfOwn)).toBe(false);
    } finally {
      cleanupData();
    }
  });
});

describe('shared library: promote (move) + adopt (copy-back to diverge)', () => {
  test('promote moves the file own → shared; then it resolves as shared', () => {
    try {
      writeComponent(SH, 'export default () => <div>promote me</div>;\n');
      expect(existsSync(ownPath)).toBe(true);
      expect(isShared(SH)).toBe(false);

      promoteComponent('default', SH);
      expect(existsSync(ownPath)).toBe(false); // MOVED, not copied
      expect(existsSync(sharedPath)).toBe(true);
      expect(isShared(SH)).toBe(true);
      // Reads span own + shared, so a canvas still sees the promoted module by bare name.
      expect(readComponent(SH)).toContain('promote me');
      expect(listComponents()).toContain(SH);
    } finally {
      cleanupShared();
    }
  });

  test('editing a promoted module writes back to the shared source (one live source)', () => {
    try {
      writeComponent(SH, 'export default () => <div>v1</div>;\n');
      promoteComponent('default', SH);
      editComponent(SH, 'v1', 'v2');
      expect(readComponent(SH)).toContain('v2');
      expect(existsSync(ownPath)).toBe(false); // still only in shared
    } finally {
      cleanupShared();
    }
  });

  test('adopt copies a shared module back into the canvas own dir (diverge)', () => {
    try {
      writeComponent(SH, 'export default () => <div>base</div>;\n');
      promoteComponent('default', SH);
      adoptSharedComponent('default', SH);
      expect(existsSync(ownPath)).toBe(true); // own copy now wins own-first resolution
      expect(existsSync(sharedPath)).toBe(true);
    } finally {
      cleanupShared();
    }
  });

  test('promote rejects a missing own file and a name collision; preserves path-escape guard', () => {
    expect(() => promoteComponent('default', 'DefinitelyMissing')).toThrow(/not in canvas/);
    expect(() => promoteComponent('default', '../secret')).toThrow(/invalid component name/);
    try {
      writeComponent(SH, 'export default () => null;\n');
      promoteComponent('default', SH);
      adoptSharedComponent('default', SH); // canvas re-owns a copy (diverged): own + shared coexist
      expect(() => promoteComponent('default', SH)).toThrow(/already exists/);
    } finally {
      cleanupShared();
    }
  });
});
