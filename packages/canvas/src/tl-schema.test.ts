// The point of this file is the ENVIRONMENT it runs in: plain `bun test`, no jsdom,
// no happy-dom. A Durable Object has the same environment. If the schema builds and
// validates here, it builds and validates there (ADR-0019, "The schema must become
// React-free"). Never add a DOM shim to this spec — that would delete its whole point.

import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { TLRecord } from '@tldraw/tlschema';

import { createCanvasTLSchema } from './tl-schema';

const componentRecord = {
  id: 'shape:c1',
  typeName: 'shape',
  type: 'component',
  parentId: 'page:page',
  index: 'a1',
  x: 0,
  y: 0,
  rotation: 0,
  isLocked: false,
  opacity: 1,
  meta: {},
  props: { w: 360, h: 260, module: 'Chart', data: {}, rev: 0, dataSource: null },
} as unknown as TLRecord & { props: Record<string, unknown> };

const chatRecord = {
  ...componentRecord,
  id: 'shape:h1',
  type: 'chat',
  props: { w: 380, h: 460, title: 'Chat', chatId: '' },
} as unknown as TLRecord & { props: Record<string, unknown> };

/** Every module reachable from `entry` by following RELATIVE imports — i.e. this
 * app's own source in the schema's import graph, which is the part we control and
 * the part that regresses. */
function ownImportGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g)].map((m) => m[1] ?? m[2] ?? '');
    seen.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(file), spec);
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p) && !p.endsWith('/'));
      if (target) visit(target);
    }
  };
  visit(entry);
  return seen;
}

// The discriminating half of the proof, and the reason the child-process check above
// does not stand alone: `import 'tldraw'` does NOT throw under a bare bun. Measured on
// 5.1.1, where it imports cleanly with no DOM present because the DOM access is
// deferred; on 5.2.5 the same import instead takes many minutes to transpile cold,
// which is no better a signal. Either way "it imported fine" would pass for a schema
// that drags in @tldraw/editor and then explodes inside a Durable Object. So this
// asserts the import graph itself: nothing reachable from ./tl-schema may name react
// or the React-bearing tldraw entrypoints.
test('nothing in the schema import graph imports React or the tldraw editor', () => {
  const banned = ['react', 'react-dom', 'react/jsx-runtime', 'tldraw', '@tldraw/editor'];
  const graph = ownImportGraph(new URL('./tl-schema.ts', import.meta.url).pathname);
  const offenders = [...graph].flatMap(([file, specs]) =>
    specs.filter((s) => banned.includes(s)).map((s) => `${file} imports ${s}`),
  );
  expect(offenders).toEqual([]);
  // Guard the guard: if the walker silently found nothing, the assertion above is vacuous.
  expect(graph.size).toBeGreaterThanOrEqual(2); // tl-schema, shape-props
});

// The AC's proof, and it has to be a CHILD process: `src/paste-detect.dom.test.ts`
// registers happy-dom globally, so by the time the whole suite runs, `document`
// exists in THIS process — asserting on it here would prove nothing. A fresh `bun`
// with no preload is the closest thing to the Durable Object's runtime we can get
// locally: if importing ./tl-schema and validating a record works there, it works
// there. If someone reintroduces a `tldraw` (i.e. @tldraw/editor) import anywhere in
// the schema's import graph, this test is what fails.
test('the schema builds and validates in a runtime with no DOM at all', () => {
  const schemaPath = new URL('./tl-schema.ts', import.meta.url).pathname;
  const source = [
    `if (typeof document !== 'undefined' || typeof window !== 'undefined') throw new Error('DOM present');`,
    `const { createCanvasTLSchema } = await import(${JSON.stringify(schemaPath)});`,
    `createCanvasTLSchema().types.shape.validate(${JSON.stringify(componentRecord)});`,
    `console.log('NO-DOM-OK');`,
  ].join('\n');
  const proc = Bun.spawnSync(['bun', '-e', source], { stdout: 'pipe', stderr: 'pipe' });
  expect(proc.stderr.toString()).toBe('');
  expect(proc.stdout.toString().trim()).toBe('NO-DOM-OK');
  expect(proc.exitCode).toBe(0);
});

test('a valid component record validates', () => {
  const schema = createCanvasTLSchema();
  expect(schema.types.shape.validate(componentRecord)).toEqual(componentRecord);
});

// `dataSource` is retired (shape-props.ts), but room records written before then still carry
// one — a mart or a Notebook query. They must keep validating, or the room fails to load.
test('a stored component record still holding a retired dataSource validates', () => {
  const schema = createCanvasTLSchema();
  for (const dataSource of [{ kind: 'mart', name: 'mart_runway' }, { kind: 'notebook', query: 'open_problems' }]) {
    const record = { ...componentRecord, props: { ...componentRecord.props, dataSource } };
    expect(() => schema.types.shape.validate(record)).not.toThrow();
  }
});

test('a valid chat record validates', () => {
  const schema = createCanvasTLSchema();
  expect(schema.types.shape.validate(chatRecord)).toEqual(chatRecord);
});

test('a component record with a wrong-typed prop is rejected', () => {
  const schema = createCanvasTLSchema();
  const bad = { ...componentRecord, props: { ...componentRecord.props, module: 42 } };
  expect(() => schema.types.shape.validate(bad)).toThrow();
});

test('a component record with a missing prop is rejected', () => {
  const schema = createCanvasTLSchema();
  const { rev, ...propsWithoutRev } = componentRecord.props;
  expect(() => schema.types.shape.validate({ ...componentRecord, props: propsWithoutRev })).toThrow();
});

test('a chat record with a wrong-typed prop is rejected', () => {
  const schema = createCanvasTLSchema();
  const bad = { ...chatRecord, props: { ...chatRecord.props, title: null } };
  expect(() => schema.types.shape.validate(bad)).toThrow();
});

test('a chat record with a missing prop is rejected', () => {
  const schema = createCanvasTLSchema();
  const { chatId, ...propsWithoutChatId } = chatRecord.props;
  expect(() => schema.types.shape.validate({ ...chatRecord, props: propsWithoutChatId })).toThrow();
});
