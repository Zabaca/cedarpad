import { describe, expect, test } from 'bun:test';

import { martsInRoomSnapshot } from './mart-scope.ts';

// ADR-0017 guest scoping, one level below decideGuestGate: the marts a canvas may expose
// are exactly the ones its OWN component instances reference — never the workspace's mart
// list. This is the pure resolver worker/mart-api.ts's guest branch consults.

// Read off the AUTHORITATIVE representation (ADR-0019, #289): once the room owns canvas
// state, the guest scope is resolved from the room's records, not from the stale
// `canvas-state.json` blob.

const doc = (state: unknown) => ({ state, lastChangedClock: 1 });
const componentRecord = (id: string, dataSource: unknown) => ({
  typeName: 'shape',
  id,
  type: 'component',
  props: { w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1, dataSource },
});

describe('martsInRoomSnapshot', () => {
  test('collects mart names from component records with a mart dataSource', () => {
    const snapshot = {
      documents: [
        doc(componentRecord('shape:1', { kind: 'mart', name: 'mart_a' })),
        doc(componentRecord('shape:2', { kind: 'mart', name: 'mart_b' })),
      ],
    };
    expect(martsInRoomSnapshot(snapshot)).toEqual(new Set(['mart_a', 'mart_b']));
  });

  test('ignores non-component records, components with no dataSource, and non-shape records', () => {
    const snapshot = {
      documents: [
        doc({ typeName: 'shape', id: 'shape:1', type: 'geo', props: { w: 1, h: 1 } }),
        doc(componentRecord('shape:2', null)),
        doc({ typeName: 'page', id: 'page:1' }),
      ],
    };
    expect(martsInRoomSnapshot(snapshot)).toEqual(new Set());
  });

  test('duplicate references collapse, and an empty room references no marts', () => {
    const snapshot = {
      documents: [
        doc(componentRecord('shape:1', { kind: 'mart', name: 'mart_a' })),
        doc(componentRecord('shape:2', { kind: 'mart', name: 'mart_a' })),
      ],
    };
    expect(martsInRoomSnapshot(snapshot)).toEqual(new Set(['mart_a']));
    expect(martsInRoomSnapshot({ documents: [] })).toEqual(new Set());
  });
});
