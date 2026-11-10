import { describe, expect, test } from 'bun:test';

import { canvasesToScan } from './component-inventory-api.ts';

describe('canvasesToScan', () => {
  test('includes the legacy `default` canvas, which has no registry row', () => {
    // `default` predates the canvas registry, so `canvasRegistry.list` never returns it —
    // `Shell.tsx` synthesizes it into the picker for the same reason. Scanning only the
    // registry misses every card on the canvas most workspaces use most, and a delete would
    // then leave those cards behind while reporting success.
    expect(canvasesToScan('default', [{ id: 'cv_a', name: 'Board A' }])).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'cv_a', name: 'Board A' },
    ]);
  });

  test('does not duplicate it if a workspace ever does have the row', () => {
    expect(canvasesToScan('default', [{ id: 'default', name: 'Main' }])).toEqual([{ id: 'default', name: 'Main' }]);
  });

  test('never for another workspace: the id is global, so it would scan the default workspace’s room', () => {
    expect(canvasesToScan('ws_a', [{ id: 'cv_a', name: 'Board A' }])).toEqual([{ id: 'cv_a', name: 'Board A' }]);
  });
});
