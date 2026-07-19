import { describe, expect, test } from 'bun:test';
import { createHuddleSupervisor } from './huddle-supervisor.ts';

// ADR-0017: one agent worker per canvas, single-flight — a join while one is alive joins
// the existing room instead of spawning a twin; after the worker exits, the next join
// spawns fresh. Max-duration is the absurdity backstop.
type FakeChild = { kill: () => void; exited: boolean; exit: () => void };

function fakeSpawner() {
  const children: FakeChild[] = [];
  let onExit: (() => void) | null = null;
  return {
    children,
    spawn: () => {
      const child: FakeChild = {
        exited: false,
        kill: () => child.exit(),
        exit: () => {
          child.exited = true;
          onExit?.();
        },
      };
      children.push(child);
      return { kill: child.kill, onExit: (cb: () => void) => { onExit = cb; } };
    },
  };
}

describe('huddle supervisor — single-flight worker per canvas', () => {
  test('two ensures spawn once (second join joins); after exit, ensure spawns again', () => {
    const s = fakeSpawner();
    const sup = createHuddleSupervisor({ spawn: s.spawn, maxDurationMs: 60_000 });
    expect(sup.ensure('cv_1').joined).toBe(false); // first: spawned
    expect(sup.ensure('cv_1').joined).toBe(true); // second: joined existing
    expect(s.children.length).toBe(1);
    s.children[0]?.exit();
    expect(sup.ensure('cv_1').joined).toBe(false); // respawned
    expect(s.children.length).toBe(2);
  });

  test('canvases are independent rooms', () => {
    const s = fakeSpawner();
    const sup = createHuddleSupervisor({ spawn: s.spawn, maxDurationMs: 60_000 });
    sup.ensure('cv_a');
    sup.ensure('cv_b');
    expect(s.children.length).toBe(2);
  });

  test('max duration kills the worker', async () => {
    const s = fakeSpawner();
    const sup = createHuddleSupervisor({ spawn: s.spawn, maxDurationMs: 20 });
    sup.ensure('cv_1');
    await new Promise((r) => setTimeout(r, 40));
    expect(s.children[0]?.exited).toBe(true);
  });
});
