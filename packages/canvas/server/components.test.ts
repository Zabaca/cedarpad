import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { editComponent, listComponents, readComponent, writeComponent } from './components.ts';

const TMP = 'Tmp_ComponentsTest';
const tmpPath = fileURLToPath(new URL(`../src/canvas-components/${TMP}.tsx`, import.meta.url));
const cleanup = () => existsSync(tmpPath) && rmSync(tmpPath);

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
