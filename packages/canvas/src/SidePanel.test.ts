// The docked side panel's pure bits: instance labeling and open-state persistence.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import { instanceLabels, loadPanelOpen, savePanelOpen } from './SidePanel';

describe('instanceLabels', () => {
  test('unique modules keep their bare name', () => {
    expect(instanceLabels([{ id: 'a', module: 'Kanban' }, { id: 'b', module: 'BarChart' }])).toEqual([
      { id: 'a', label: 'Kanban' },
      { id: 'b', label: 'BarChart' },
    ]);
  });
  test('duplicate modules are numbered in page order', () => {
    expect(instanceLabels([{ id: 'a', module: 'Kanban' }, { id: 'b', module: 'Slide' }, { id: 'c', module: 'Kanban' }])).toEqual([
      { id: 'a', label: 'Kanban 1' },
      { id: 'b', label: 'Slide' },
      { id: 'c', label: 'Kanban 2' },
    ]);
  });
});

describe('panel open persistence', () => {
  afterEach(() => localStorage.removeItem('agent-canvas:side-panel'));
  test('defaults open; a saved collapse survives reload', () => {
    expect(loadPanelOpen()).toBe(true);
    savePanelOpen(false);
    expect(loadPanelOpen()).toBe(false);
    savePanelOpen(true);
    expect(loadPanelOpen()).toBe(true);
  });
});
