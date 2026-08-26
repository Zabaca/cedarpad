// The shared placed-instance list: the same component the side panel renders and the
// fullscreen rail mounts. Order and labelling live here so the two surfaces cannot drift.
import './happydom-harness.ts';

import { describe, expect, test, afterEach } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ComponentInstanceList, instanceLabels, readComponentInstances } from './ComponentInstanceList';

describe('instanceLabels', () => {
  test('unique modules keep their bare name', () => {
    expect(
      instanceLabels([
        { id: 'a', module: 'Kanban' },
        { id: 'b', module: 'BarChart' },
      ]),
    ).toEqual([
      { id: 'a', label: 'Kanban' },
      { id: 'b', label: 'BarChart' },
    ]);
  });

  test('duplicate modules are numbered in page order', () => {
    expect(
      instanceLabels([
        { id: 'a', module: 'Kanban' },
        { id: 'b', module: 'Slide' },
        { id: 'c', module: 'Kanban' },
      ]),
    ).toEqual([
      { id: 'a', label: 'Kanban 1' },
      { id: 'b', label: 'Slide' },
      { id: 'c', label: 'Kanban 2' },
    ]);
  });
});

describe('readComponentInstances', () => {
  test('keeps only component shapes, in page order, and falls back to ? for a missing module', () => {
    const editor = {
      getCurrentPageShapes: () => [
        { id: 'shape:a', type: 'component', props: { module: 'Kanban' } },
        { id: 'shape:b', type: 'geo', props: {} },
        { id: 'shape:c', type: 'component', props: {} },
      ],
    };
    expect(readComponentInstances(editor)).toEqual([
      { id: 'shape:a', module: 'Kanban' },
      { id: 'shape:c', module: '?' },
    ]);
  });
});

const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

async function render(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(node as never);
  });
  return el;
}

const items = [
  { id: 'shape:a', label: 'Kanban 1' },
  { id: 'shape:b', label: 'Kanban 2' },
];

describe('ComponentInstanceList', () => {
  test('renders a row per instance, in order, labelled', async () => {
    const el = await render(<ComponentInstanceList items={items} onPrimary={() => {}} />);
    const labels = [...el.querySelectorAll('.instance-list-label')].map((n) => n.textContent);
    expect(labels).toEqual(['Kanban 1', 'Kanban 2']);
  });

  test('an empty list says so', async () => {
    const el = await render(<ComponentInstanceList items={[]} onPrimary={() => {}} />);
    expect(el.querySelector('.instance-list-empty')).not.toBeNull();
    expect(el.querySelectorAll('.instance-list-row').length).toBe(0);
  });

  test('a row click fires the caller’s primary handler with that shape id', async () => {
    const got: string[] = [];
    const el = await render(<ComponentInstanceList items={items} onPrimary={(id) => got.push(id)} />);
    await act(async () => {
      (el.querySelectorAll('.instance-list-label')[1] as HTMLButtonElement).click();
    });
    expect(got).toEqual(['shape:b']);
  });

  test('without onExpand no row carries a fullscreen button', async () => {
    const el = await render(<ComponentInstanceList items={items} onPrimary={() => {}} />);
    expect(el.querySelectorAll('.instance-list-expand').length).toBe(0);
  });

  test('with onExpand every row carries one, and it fires with that row’s shape id', async () => {
    const got: string[] = [];
    const el = await render(<ComponentInstanceList items={items} onPrimary={() => {}} onExpand={(id) => got.push(id)} />);
    const expands = el.querySelectorAll('.instance-list-expand');
    expect(expands.length).toBe(2);
    await act(async () => {
      (expands[0] as HTMLButtonElement).click();
    });
    expect(got).toEqual(['shape:a']);
  });

  test('the fullscreen button does not also fire the primary handler', async () => {
    const primary: string[] = [];
    const expanded: string[] = [];
    const el = await render(
      <ComponentInstanceList items={items} onPrimary={(id) => primary.push(id)} onExpand={(id) => expanded.push(id)} />,
    );
    await act(async () => {
      (el.querySelector('.instance-list-expand') as HTMLButtonElement).click();
    });
    expect(expanded).toEqual(['shape:a']);
    expect(primary).toEqual([]);
  });

  test('the active row is marked, and only that one', async () => {
    const el = await render(<ComponentInstanceList items={items} activeId="shape:b" onPrimary={() => {}} />);
    const rows = [...el.querySelectorAll('.instance-list-row')];
    expect(rows.map((r) => r.getAttribute('data-active'))).toEqual([null, 'true']);
  });
});
