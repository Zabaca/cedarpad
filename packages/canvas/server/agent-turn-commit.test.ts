// #310: the chat agent's canvas tools settle against the room after EVERY tool call.
//
// The tool handler is the await point (it is already `async`), one level above
// `src/canvas-ops.ts` — which stays synchronous and untouched, per ADR-0019's seam.

import { describe, expect, test } from 'bun:test';

import { createCanvasTools } from './agent.ts';
import { createStore } from '../src/store.ts';
import type { TurnCanvasStore } from './turn-canvas-store.ts';

function fakeTurnStore(opts: { commitFails?: string } = {}) {
  const inner = createStore([]);
  const calls: string[] = [];
  const store: TurnCanvasStore = {
    getState: () => inner.getState(),
    upsert: (s) => inner.upsert(s),
    remove: (ids) => inner.remove(ids),
    clear: () => inner.clear(),
    commit: async () => {
      calls.push('commit');
      if (opts.commitFails) throw new Error(opts.commitFails);
    },
    discard: async () => {
      calls.push('discard');
    },
  };
  return { store, calls };
}

const callTool = async (store: TurnCanvasStore, name: string, args: Record<string, unknown>) => {
  const t = createCanvasTools(store).find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (await t.handler(args as never, undefined)) as { content: Array<{ text?: string }>; isError?: boolean };
};

describe('canvas tools settle against the room', () => {
  test('a successful create_shapes commits', async () => {
    const { store, calls } = fakeTurnStore();
    const res = await callTool(store, 'create_shapes', { shapes: [{ type: 'note', x: 0, y: 0, text: 'hi' }] });

    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(['commit']);
  });

  test('a commit failure becomes the tool\'s own error — the agent is told, never a silent success', async () => {
    const { store, calls } = fakeTurnStore({ commitFails: 'room said no' });
    const res = await callTool(store, 'create_shapes', { shapes: [{ type: 'note', x: 0, y: 0, text: 'doomed' }] });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('room said no');
    expect(calls).toEqual(['commit']);
  });

  test('a refused op discards instead of committing', async () => {
    const { store, calls } = fakeTurnStore();
    // An arrow with neither coordinates nor bindings — normalizeShape refuses it.
    const res = await callTool(store, 'create_shapes', { shapes: [{ type: 'arrow' }] });

    expect(res.isError).toBe(true);
    expect(calls).toEqual(['discard']);
  });

  test('a plain CanvasStore (no room) is unaffected — the wrapper is a no-op', async () => {
    const plain = createStore([]);
    const t = createCanvasTools(plain).find((d) => d.name === 'create_shapes')!;
    const res = (await t.handler({ shapes: [{ type: 'note', x: 0, y: 0, text: 'hi' }] } as never, undefined as never)) as { isError?: boolean };
    expect(res.isError).toBeUndefined();
    expect(plain.getState().shapes).toHaveLength(1);
  });
});
