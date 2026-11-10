import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../src/store.ts';
import { callComponent, loadCommands } from './component-commands.ts';

// A real file on disk behind the `resolve` seam, so the dynamic import is the one production
// runs. The fixtures carry a hand-rolled `safeParse` rather than importing zod: a temp dir has
// no node_modules to resolve it from, and the loader only asks that `args` can safeParse.
const dir = mkdtempSync(join(tmpdir(), 'cedarpad-cmds-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string, source: string) => {
  const path = join(dir, `${name}.tsx`);
  writeFileSync(path, source);
  return async () => path;
};
const commandsSource = (name: string) => `
  const anyArgs = { safeParse: (v) => ({ success: true, data: v }) };
  export const commands = { ${name}: { args: anyArgs, run: (data) => ({ ...data, last: '${name}' }) } };
  export default function C() { return null; }
`;

describe('loadCommands', () => {
  test("returns the module's commands", async () => {
    const cmds = await loadCommands('C', 'cv', fixture('Ok', commandsSource('ping')));
    expect(Object.keys(cmds)).toEqual(['ping']);
    expect(cmds.ping!.run({}, {} as never)).toEqual({ last: 'ping' });
  });

  test('an edited file is re-imported, not served from the module cache', async () => {
    const resolve = fixture('Edited', commandsSource('before'));
    expect(Object.keys(await loadCommands('C', 'cv', resolve))).toEqual(['before']);
    fixture('Edited', commandsSource('after'));
    expect(Object.keys(await loadCommands('C', 'cv', resolve))).toEqual(['after']);
  });

  test('a component with no commands export has none', async () => {
    expect(await loadCommands('C', 'cv', fixture('Plain', 'export default function C() { return null; }'))).toEqual({});
  });

  test('a module that touches the DOM at the top level fails with a readable error', async () => {
    const resolve = fixture('Dom', 'const w = window.innerWidth;\nexport const commands = {};\nexport default function C() { return w; }');
    await expect(loadCommands('Dom', 'cv', resolve)).rejects.toThrow(/could not load <Dom>.*top level/s);
  });

  test('a commands export in the wrong shape is refused, naming the bad entry', async () => {
    const resolve = fixture('Bad', 'export const commands = { go: { args: {}, run: 1 } };\nexport default function C() { return null; }');
    await expect(loadCommands('Bad', 'cv', resolve)).rejects.toThrow(/go\.args.*zod schema/s);
  });
});

describe('callComponent', () => {
  test("loads the placed instance's module and runs the command on it", async () => {
    const store = createStore();
    store.upsert([{ id: 'cmp_1', type: 'component', color: 'black', x: 0, y: 0, w: 1, h: 1, module: 'Thing', data: { n: 1 }, rev: 1 }]);
    const asked: string[] = [];
    const r = await callComponent(store, 'cv', 'cmp_1', 'ping', {}, async (module, canvasId) => {
      asked.push(`${canvasId}/${module}`);
      return loadCommands(module, canvasId, fixture('Thing', commandsSource('ping')));
    });
    expect(r.isError).toBeUndefined();
    expect(asked).toEqual(['cv/Thing']);
    const s = store.getState().shapes[0]!;
    expect(s.type === 'component' && s.data).toEqual({ n: 1, last: 'ping' });
  });

  test('a missing instance errors without loading anything', async () => {
    const r = await callComponent(createStore(), 'cv', 'ghost', 'ping', {}, async () => {
      throw new Error('should not load');
    });
    expect(r.isError).toBe(true);
  });
});
