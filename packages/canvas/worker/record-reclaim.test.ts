import { describe, expect, test } from 'bun:test';

import { deleteCanvasRecords } from './record-reclaim.ts';
import { memRecordStore } from './record-store.ts';

// Deleting a canvas, stated as the rules a workspace owner depends on (ADR-0022 decision 9).
// Run against the in-memory Record port — no database, because none of this is about rows.

describe('deleting a canvas', () => {
  test("hides everything the canvas owns — data files included — and leaves the shared library alone", async () => {
    const records = memRecordStore();
    const workspaceId = 'ws_1';
    await records.put({ workspaceId, canvasId: 'cv_1', name: 'Card', kind: 'component', source: 'c', updatedBy: null });
    await records.put({ workspaceId, canvasId: 'cv_1', name: 'sales.json', kind: 'data', source: '[]', updatedBy: null });
    await records.put({ workspaceId, canvasId: null, name: 'Card', kind: 'component', source: 's', updatedBy: null });

    await deleteCanvasRecords(records, { workspaceId, canvasId: 'cv_1' });

    // A data file left behind would be an orphan: nothing lists it and nothing reclaims it.
    expect(await records.list({ workspaceId, canvasId: 'cv_1' })).toEqual([]);
    // The shared library belongs to the workspace and outlives any canvas in it.
    expect((await records.list({ workspaceId, canvasId: null })).map((r) => r.name)).toEqual(['Card']);
  });

  test('refuses a scope with no canvas, rather than emptying the shared library', async () => {
    const records = memRecordStore();
    const workspaceId = 'ws_1';
    await records.put({ workspaceId, canvasId: null, name: 'Card', kind: 'component', source: 's', updatedBy: null });

    // A blank id is what a caller that lost the canvas would pass, and the in-memory port keys
    // the shared tier by exactly that — so the refusal is a rule, not a type-checker courtesy.
    await expect(deleteCanvasRecords(records, { workspaceId, canvasId: '' })).rejects.toThrow(/canvas id is required/);
    expect((await records.list({ workspaceId, canvasId: null })).map((r) => r.name)).toEqual(['Card']);
  });
});
