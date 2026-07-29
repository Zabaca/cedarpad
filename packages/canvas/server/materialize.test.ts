import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ComponentRecords } from './components.ts';
import { componentMaterializeMiddleware, parseComponentModulePath } from './materialize.ts';

// On-demand materialization (ADR-0022 decision 5). There is no boot restore: the browser asks
// vite for a module, vite has no file, and the Record becomes one right then. This is what
// makes a container recycle a slow first request instead of a data event.

const CANVAS = 'cvmaterializetest';
const dirPath = fileURLToPath(new URL(`../src/canvas-${CANVAS}/`, import.meta.url));
const filePath = (name: string) => `${dirPath}components/${name}.tsx`;

afterEach(() => {
  if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true });
});

const fakeRecords = (rows: Record<string, string>): ComponentRecords => ({
  write: async () => {},
  read: async (canvasId, name) => rows[`${canvasId}/${name}`] ?? null,
  history: async () => [],
});

/** Drive the connect-style middleware and resolve once it has called `next()`. */
const request = (mw: ReturnType<typeof componentMaterializeMiddleware>, url: string) =>
  new Promise<void>((resolve) => mw({ url }, {}, resolve));

describe('resolving a request path to a Component (pure)', () => {
  test('a canvas own-tier module URL names its canvas and module', () => {
    expect(parseComponentModulePath('/src/canvas-cv_1/components/KpiCard.tsx?r=3&n=7')).toEqual({
      canvasId: 'cv_1',
      module: 'KpiCard',
    });
  });

  test.each([
    ['/src/canvas-components/KpiCard.tsx', 'the platform tier is image code, never a Record'],
    ['/shared/components/KpiCard.tsx', 'the shared tier is not carried by this slice'],
    ['/src/canvas-cv_1/components/sales.json', 'data files are not carried by this slice'],
    ['/src/canvas-cv_1/components/../../secret.tsx', 'a traversing path names no Component'],
    ['/src/main.tsx', 'an ordinary app module'],
  ])('%s resolves to nothing — %s', (path) => {
    expect(parseComponentModulePath(path)).toBeNull();
  });
});

describe('the dev-server middleware materializes on a miss', () => {
  test('a module with no file is written from its Record before vite is handed the request', async () => {
    const mw = componentMaterializeMiddleware(fakeRecords({ [`${CANVAS}/Card`]: 'export default () => null;' }));

    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx?r=1&n=1`);

    expect(readFileSync(filePath('Card'), 'utf8')).toBe('export default () => null;');
  });

  test('a module the store has never held is passed through — a 404 the client already expects', async () => {
    const mw = componentMaterializeMiddleware(fakeRecords({}));
    await request(mw, `/src/canvas-${CANVAS}/components/Ghost.tsx`);
    expect(existsSync(filePath('Ghost'))).toBe(false);
  });

  test('a module already on disk is not re-fetched — a warm container pays nothing', async () => {
    const asked: string[] = [];
    const mw = componentMaterializeMiddleware({
      write: async () => {},
      read: async (_c, name) => {
        asked.push(name);
        return 'from store';
      },
      history: async () => [],
    });
    mkdirSync(`${dirPath}components/`, { recursive: true });
    writeFileSync(filePath('Card'), 'from disk');

    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx`);
    expect(asked).toEqual([]);
    expect(readFileSync(filePath('Card'), 'utf8')).toBe('from disk');
  });

  test('a store that throws still hands the request on — a blip is a retryable 404, not a crash', async () => {
    const mw = componentMaterializeMiddleware({
      write: async () => {},
      read: async () => {
        throw new Error('store unreachable');
      },
      history: async () => [],
    });
    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx`);
    expect(existsSync(filePath('Card'))).toBe(false);
  });

  test('with no store configured the middleware is inert', async () => {
    const mw = componentMaterializeMiddleware(null);
    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx`);
    expect(existsSync(filePath('Card'))).toBe(false);
  });
});
