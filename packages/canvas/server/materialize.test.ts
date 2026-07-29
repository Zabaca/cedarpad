import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ComponentRecords } from './components.ts';
import { componentMaterializeMiddleware, parseComponentModulePath, parseDataModulePath } from './materialize.ts';

// On-demand materialization (ADR-0022 decision 5). There is no boot restore: the browser asks
// vite for a module, vite has no file, and the Record becomes one right then. This is what
// makes a container recycle a slow first request instead of a data event.

const CANVAS = 'cvmaterializetest';
const dirPath = fileURLToPath(new URL(`../src/canvas-${CANVAS}/`, import.meta.url));
const filePath = (name: string) => `${dirPath}components/${name}.tsx`;
const sharedDir = fileURLToPath(new URL('../shared/components/', import.meta.url));
const sharedPath = (name: string) => `${sharedDir}${name}.tsx`;
const SHARED_NAME = 'Tmp_MaterializeShared';

afterEach(() => {
  if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true });
  if (existsSync(sharedPath(SHARED_NAME))) rmSync(sharedPath(SHARED_NAME));
});

/** Rows keyed by tier, as the store keys them — the shared library has no canvas of its own. */
const fakeRecords = (rows: Record<string, string>): ComponentRecords => ({
  write: async () => {},
  read: async (tier, canvasId, name) => rows[tier === 'shared' ? `shared/${name}` : `${canvasId}/${name}`] ?? null,
  history: async () => [],
  promote: async () => {},
  adopt: async () => {},
  writeData: async () => {},
  readData: async (canvasId, name) => rows[`${canvasId}/${name}`] ?? null,
});

/** Drive the connect-style middleware and resolve once it has called `next()`. */
const request = (mw: ReturnType<typeof componentMaterializeMiddleware>, url: string) =>
  new Promise<void>((resolve) => mw({ url }, {}, resolve));

describe('resolving a request path to a Component (pure)', () => {
  test('a canvas own-tier module URL names its canvas and module', () => {
    expect(parseComponentModulePath('/src/canvas-cv_1/components/KpiCard.tsx?r=3&n=7')).toEqual({
      tier: 'own',
      canvasId: 'cv_1',
      module: 'KpiCard',
    });
  });

  test('a shared-library module URL names the module and the canvas asking for it', () => {
    // The canvas rides along because the edge proves entitlement to a workspace's shared
    // library through a canvas inside it — so even a shared read has to name one.
    expect(parseComponentModulePath('/shared/components/KpiCard.tsx?r=3&n=7&c=cv_1')).toEqual({
      tier: 'shared',
      canvasId: 'cv_1',
      module: 'KpiCard',
    });
  });

  test.each([
    ['/src/canvas-components/KpiCard.tsx', 'the platform tier is image code, never a Record'],
    ['/shared/components/KpiCard.tsx', 'a shared read naming no canvas cannot prove entitlement'],
    ['/src/canvas-cv_1/components/sales.json', 'a data file is not a Component module'],
    ['/src/canvas-cv_1/components/../../secret.tsx', 'a traversing path names no Component'],
    ['/shared/components/../../secret.tsx?c=cv_1', 'nor does a traversing shared path'],
    ['/src/main.tsx', 'an ordinary app module'],
  ])('%s resolves to nothing — %s', (path) => {
    expect(parseComponentModulePath(path)).toBeNull();
  });
});

describe('resolving a request path to a data file (pure)', () => {
  test.each([
    ['/src/canvas-cv_1/components/sales.json?import', 'sales.json'],
    ['/src/canvas-cv_1/components/rows.csv?raw', 'rows.csv'],
    ['/src/canvas-cv_1/components/notes.md', 'notes.md'],
    ['/src/canvas-cv_1/components/readme.txt?t=17', 'readme.txt'],
  ])('%s names its canvas and data file', (path, file) => {
    // A data import is not the same request shape as a `.tsx` one: vite tags it (`?import`,
    // `?raw`), so the query has to come off before the extension is judged.
    expect(parseDataModulePath(path)).toEqual({ canvasId: 'cv_1', file });
  });

  test.each([
    ['/src/canvas-cv_1/components/KpiCard.tsx', 'a Component is not a data file'],
    ['/src/canvas-cv_1/components/evil.ts', 'an executable extension is outside the closed set'],
    ['/src/canvas-cv_1/components/../../secret.json', 'a traversing path names no data file'],
    ['/shared/components/sales.json', 'the shared tier is not carried by this slice'],
    ['/src/canvas-components/sales.json', 'the platform tier is image code, never a Record'],
  ])('%s resolves to nothing — %s', (path) => {
    expect(parseDataModulePath(path)).toBeNull();
  });
});

describe('the dev-server middleware materializes on a miss', () => {
  test('a module with no file is written from its Record before vite is handed the request', async () => {
    const mw = componentMaterializeMiddleware(fakeRecords({ [`${CANVAS}/Card`]: 'export default () => null;' }));

    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx?r=1&n=1`);

    expect(readFileSync(filePath('Card'), 'utf8')).toBe('export default () => null;');
  });

  test('a shared module with no file is written from its Record too', async () => {
    // Without this a recycled container 404s every promoted Component and the client falls
    // through to a same-named PLATFORM module — the silent substitution that rendered three
    // promoted cards blank, with no error anywhere.
    const mw = componentMaterializeMiddleware(fakeRecords({ [`shared/${SHARED_NAME}`]: '// the shared source\n' }));

    await request(mw, `/shared/components/${SHARED_NAME}.tsx?r=1&n=1&c=${CANVAS}`);

    expect(readFileSync(sharedPath(SHARED_NAME), 'utf8')).toBe('// the shared source\n');
  });

  test('a module the store has never held is passed through — a 404 the client already expects', async () => {
    const mw = componentMaterializeMiddleware(fakeRecords({}));
    await request(mw, `/src/canvas-${CANVAS}/components/Ghost.tsx`);
    expect(existsSync(filePath('Ghost'))).toBe(false);
  });

  test('a module already on disk is not re-fetched — a warm container pays nothing', async () => {
    const asked: string[] = [];
    const mw = componentMaterializeMiddleware({
      ...fakeRecords({}),
      read: async (_tier, _canvasId, name) => {
        asked.push(name);
        return 'from store';
      },
      history: async () => [],
      promote: async () => {},
      adopt: async () => {},
    });
    mkdirSync(`${dirPath}components/`, { recursive: true });
    writeFileSync(filePath('Card'), 'from disk');

    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx`);
    expect(asked).toEqual([]);
    expect(readFileSync(filePath('Card'), 'utf8')).toBe('from disk');
  });

  test('a store that throws still hands the request on — a blip is a retryable 404, not a crash', async () => {
    const mw = componentMaterializeMiddleware({
      ...fakeRecords({}),
      read: async () => {
        throw new Error('store unreachable');
      },
      history: async () => [],
      promote: async () => {},
      adopt: async () => {},
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

describe('the middleware serves data files too, not just Components', () => {
  const dataPath = (file: string) => `${dirPath}components/${file}`;

  test('a Component materializes with the data file it imports, in one request', async () => {
    // The whole failure this removes: vite resolves `./sales.json` off the filesystem while
    // it transforms Card.tsx. A Component that arrived without its sibling would 500 on
    // import analysis, and the card would be dead — with the source sitting safely in a row.
    const mw = componentMaterializeMiddleware(
      fakeRecords({
        [`${CANVAS}/Card`]: 'import rows from "./sales.json";\nexport default () => rows;\n',
        [`${CANVAS}/sales.json`]: '{"rows":[1]}',
      }),
    );

    await request(mw, `/src/canvas-${CANVAS}/components/Card.tsx?r=1&n=1`);

    expect(readFileSync(dataPath('sales.json'), 'utf8')).toBe('{"rows":[1]}');
  });

  test('a data file requested on its own is materialized from its Record', async () => {
    const mw = componentMaterializeMiddleware(fakeRecords({ [`${CANVAS}/sales.json`]: '{"rows":[1]}' }));

    await request(mw, `/src/canvas-${CANVAS}/components/sales.json?import`);

    expect(readFileSync(dataPath('sales.json'), 'utf8')).toBe('{"rows":[1]}');
  });

  test('a data file the store has never held is passed through, not an error', async () => {
    const mw = componentMaterializeMiddleware(fakeRecords({}));
    await request(mw, `/src/canvas-${CANVAS}/components/ghost.json`);
    expect(existsSync(dataPath('ghost.json'))).toBe(false);
  });

  test('a data file already on disk is not re-fetched', async () => {
    const asked: string[] = [];
    const mw = componentMaterializeMiddleware({
      ...fakeRecords({}),
      readData: async (_c, name) => {
        asked.push(name);
        return 'from store';
      },
    });
    mkdirSync(`${dirPath}components/`, { recursive: true });
    writeFileSync(dataPath('sales.json'), 'from disk');

    await request(mw, `/src/canvas-${CANVAS}/components/sales.json?import`);
    expect(asked).toEqual([]);
    expect(readFileSync(dataPath('sales.json'), 'utf8')).toBe('from disk');
  });
});
