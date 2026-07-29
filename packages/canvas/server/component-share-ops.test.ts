import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isShared, writeComponent } from './components.ts';
import { adoptFromShared, promoteToShared } from './component-share-ops.ts';

// A unique module name so the round-trip never collides with the seed library.
const SH = 'Tmp_ShareOps';
const ownPath = fileURLToPath(new URL(`../src/canvas-default/components/${SH}.tsx`, import.meta.url));
const sharedPath = fileURLToPath(new URL(`../shared/components/${SH}.tsx`, import.meta.url));
const cleanup = () => {
  if (existsSync(ownPath)) rmSync(ownPath);
  if (existsSync(sharedPath)) rmSync(sharedPath);
};

describe('promoteToShared — the promote+reload pairing', () => {
  test('moves own→shared, THEN reloads, and returns the reload count', async () => {
    try {
      await writeComponent(SH, 'export default () => <div>share me</div>;\n');

      const reloaded = promoteToShared('default', SH, () => {
        // The reload must observe the post-move state: the file is already shared.
        expect(isShared(SH)).toBe(true);
        return 3;
      });

      expect(existsSync(ownPath)).toBe(false); // MOVED, not copied
      expect(existsSync(sharedPath)).toBe(true);
      expect(reloaded).toBe(3); // the op returns what reload reports
    } finally {
      cleanup();
    }
  });

  test('a failed move does not fire the reload', () => {
    let reloadFired = false;
    expect(() => promoteToShared('default', 'DefinitelyMissing', () => ((reloadFired = true), 1))).toThrow(/not in canvas/);
    expect(reloadFired).toBe(false);
  });
});

describe('adoptFromShared — the adopt+reload pairing', () => {
  test('copies shared→own, THEN reloads, and returns the reload count', async () => {
    try {
      await writeComponent(SH, 'export default () => <div>base</div>;\n');
      promoteToShared('default', SH, () => 0); // seed a shared module to adopt

      const reloaded = adoptFromShared('default', SH, () => {
        expect(existsSync(ownPath)).toBe(true); // own copy already in place when reload runs
        return 2;
      });

      expect(existsSync(ownPath)).toBe(true); // COPIED back (own now shadows shared)
      expect(existsSync(sharedPath)).toBe(true); // shared source still there
      expect(reloaded).toBe(2);
    } finally {
      cleanup();
    }
  });
});
