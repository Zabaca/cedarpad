import { describe, expect, test } from 'bun:test';

import { componentCatalog } from './component-catalog.ts';
import { memRecordStore } from './record-store.ts';

const WS = 'ws_1';
const CV = 'cv_1';

describe('the component catalog', () => {
  test("lists a canvas's own Component with its tier and its leading-comment description", async () => {
    const records = memRecordStore();
    await records.put({
      workspaceId: WS,
      canvasId: CV,
      name: 'SalesCard',
      kind: 'component',
      source: '// Quarterly sales.\nexport default () => null;',
      updatedBy: null,
    });

    expect(await componentCatalog(records, { workspaceId: WS, canvasId: CV }, [])).toEqual([
      { name: 'SalesCard', description: 'Quarterly sales.', tier: 'own' },
    ]);
  });

  // PRD #354 story 41. The listing has to answer with the tier the canvas RESOLVES, because
  // that is what the next write edits: a shadowed shared module reported as `shared` sends an
  // edit into the workspace's one source instead of this canvas's copy.
  test('own beats shared beats base — one entry per name, labelled with the tier that wins', async () => {
    const records = memRecordStore();
    const put = (canvasId: string | null, name: string, note: string) =>
      records.put({ workspaceId: WS, canvasId, name, kind: 'component', source: `// ${note}\n`, updatedBy: null });
    await put(CV, 'Everywhere', 'own copy');
    await put(null, 'Everywhere', 'shared copy');
    await put(null, 'SharedOnly', 'shared copy');
    await put(CV, 'Shadowed', 'own copy');

    const entries = await componentCatalog(records, { workspaceId: WS, canvasId: CV }, [
      { name: 'Everywhere', description: 'base copy' },
      { name: 'Shadowed', description: 'base copy' },
      { name: 'BaseOnly', description: 'base copy' },
    ]);

    expect(entries).toEqual([
      { name: 'BaseOnly', description: 'base copy', tier: 'base' },
      { name: 'Everywhere', description: 'own copy', tier: 'own' },
      { name: 'Shadowed', description: 'own copy', tier: 'own' },
      { name: 'SharedOnly', description: 'shared copy', tier: 'shared' },
    ]);
  });

  test('another canvas\'s own Component is not in this canvas\'s library', async () => {
    const records = memRecordStore();
    await records.put({ workspaceId: WS, canvasId: 'cv_other', name: 'TheirCard', kind: 'component', source: '// x\n', updatedBy: null });

    expect(await componentCatalog(records, { workspaceId: WS, canvasId: CV }, [])).toEqual([]);
  });

  // Data files share the table with Components (`kind`), and a `sales.json` in the placeable
  // library would be a card nothing can render.
  test('a data file is not a Component', async () => {
    const records = memRecordStore();
    await records.put({ workspaceId: WS, canvasId: CV, name: 'sales.json', kind: 'data', source: '[]', updatedBy: null });

    expect(await componentCatalog(records, { workspaceId: WS, canvasId: CV }, [])).toEqual([]);
  });

  // Soft delete is the only delete there is (ADR-0022 decision 9): a deleted Component must
  // leave the library, and the platform module it was shadowing must come back into view.
  test('a soft-deleted own Component leaves the listing, revealing the tier beneath it', async () => {
    const records = memRecordStore();
    await records.put({ workspaceId: WS, canvasId: CV, name: 'Shadow', kind: 'component', source: '// own\n', updatedBy: null });
    await records.softDelete({ workspaceId: WS, canvasId: CV, name: 'Shadow' });

    expect(await componentCatalog(records, { workspaceId: WS, canvasId: CV }, [{ name: 'Shadow', description: 'base' }])).toEqual([
      { name: 'Shadow', description: 'base', tier: 'base' },
    ]);
  });
});
