import { describe, expect, test } from 'bun:test';

import { createStageMemory } from './stage-memory';

// The rail builds a fresh urlForStage(next) on every click, which drops any stage-specific
// query params (canvas's ?canvas=<id>, inbox's ?view=/&workspace=/&conv=). Stage memory closes
// that gap: it remembers the last `location.search` seen on each stage, so re-entering a stage
// via the rail restores it instead of always landing on the bare default. Per-tab only —
// deliberately not localStorage (see stage.ts's neighbors, canvas-url.ts / inbox-url.ts).
describe('stage memory', () => {
  test('a stage with nothing remembered falls back to urlForStage', () => {
    const memory = createStageMemory();
    expect(memory.urlFor('canvas')).toBe('/');
    expect(memory.urlFor('inbox')).toBe('/?stage=inbox');
  });

  test('remembering a search restores it verbatim on re-entry', () => {
    const memory = createStageMemory();
    memory.remember('canvas', '?canvas=cv_1');
    expect(memory.urlFor('canvas')).toBe('/?canvas=cv_1');

    memory.remember('inbox', '?stage=inbox&view=open&conv=abc');
    expect(memory.urlFor('inbox')).toBe('/?stage=inbox&view=open&conv=abc');
  });

  test('remembering an empty search is still the clean default', () => {
    const memory = createStageMemory();
    memory.remember('canvas', '');
    expect(memory.urlFor('canvas')).toBe('/');
  });

  test('each stage remembers its own search independently', () => {
    const memory = createStageMemory();
    memory.remember('canvas', '?canvas=cv_1');
    memory.remember('inbox', '?stage=inbox&view=open');

    expect(memory.urlFor('canvas')).toBe('/?canvas=cv_1');
    expect(memory.urlFor('inbox')).toBe('/?stage=inbox&view=open');
    expect(memory.urlFor('notebook')).toBe('/?stage=notebook');
  });

  test('re-remembering a stage overwrites the earlier value', () => {
    const memory = createStageMemory();
    memory.remember('canvas', '?canvas=cv_1');
    memory.remember('canvas', '?canvas=cv_2');
    expect(memory.urlFor('canvas')).toBe('/?canvas=cv_2');
  });
});
