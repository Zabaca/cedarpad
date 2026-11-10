// The docked side panel's pure bits: open-state persistence. (Instance labelling moved
// to ComponentInstanceList, and is tested there.)
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import { loadPanelOpen, savePanelOpen } from './SidePanel';

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
