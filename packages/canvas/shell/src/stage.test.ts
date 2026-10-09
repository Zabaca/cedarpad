import { describe, expect, test } from 'bun:test';

import { STAGES, stageFromUrl, urlForStage } from './stage';

// The rail's selection is a URL, not just component state: reloading `/?stage=settings` must
// land back on Settings. The shell is served from ASSETS at `/` only, so the stage rides in
// the query string.
describe('stage ↔ URL', () => {
  test('bare `/` is the canvas stage', () => {
    expect(stageFromUrl('')).toBe('canvas');
    expect(stageFromUrl('?')).toBe('canvas');
  });

  test('each stage round-trips through its URL', () => {
    for (const stage of STAGES) expect(stageFromUrl(new URL(urlForStage(stage), 'https://x').search)).toBe(stage);
  });

  test('the canvas stage is the clean URL, not `?stage=canvas`', () => {
    expect(urlForStage('canvas')).toBe('/');
    expect(urlForStage('notebook')).toBe('/?stage=notebook');
  });

  test('a stage that no longer exists (the retired Inbox) lands on the canvas', () => {
    expect(stageFromUrl('?stage=inbox')).toBe('canvas');
  });

  test('settings is a stage (#192) and round-trips', () => {
    expect(STAGES).toContain('settings');
    expect(stageFromUrl('?stage=settings')).toBe('settings');
  });

  test('components is a stage and round-trips', () => {
    expect(STAGES).toContain('components');
    expect(stageFromUrl('?stage=components')).toBe('components');
  });

  test('an unknown stage falls back to canvas rather than rendering nothing', () => {
    expect(stageFromUrl('?stage=wat')).toBe('canvas');
  });
});
