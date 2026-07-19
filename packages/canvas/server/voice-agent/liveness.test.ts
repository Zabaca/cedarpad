import { describe, expect, test } from 'bun:test';
import { createLiveness } from './liveness.ts';

// ADR-0017 invariant: humans keep the huddle alive; nothing else does. The agent is a
// participant but never counts toward liveness. Exit fires only after the room has held
// zero humans for the grace window; a rejoin within it cancels.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('huddle liveness — exit when the last human leaves', () => {
  test('last human leaving → onExit after grace; the agent alone never counts', async () => {
    let exited = false;
    const l = createLiveness({ graceMs: 20, isAgent: (id) => id === 'cedar', onExit: () => { exited = true; } });
    l.join('cedar');
    l.join('james');
    l.leave('james');
    expect(exited).toBe(false); // grace pending
    await wait(40);
    expect(exited).toBe(true); // cedar alone did not keep it alive
  });

  test('a rejoin within grace cancels the exit', async () => {
    let exited = false;
    const l = createLiveness({ graceMs: 30, isAgent: (id) => id === 'cedar', onExit: () => { exited = true; } });
    l.join('james');
    l.leave('james');
    l.join('james'); // came back
    await wait(60);
    expect(exited).toBe(false);
  });

  test('exit fires only when ALL humans are gone, not on any single leave', async () => {
    let exited = false;
    const l = createLiveness({ graceMs: 20, isAgent: () => false, onExit: () => { exited = true; } });
    l.join('james');
    l.join('khoa');
    l.leave('james');
    await wait(40);
    expect(exited).toBe(false); // khoa still in the room
  });
});
