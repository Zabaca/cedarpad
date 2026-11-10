// The Outliner is a SHARED surface: the tree it renders is the `nodes` prop, and the only
// way it changes is `setData`. These tests pin exactly that, because the bug they exist to
// prevent — mirroring `nodes` into local state at mount — looks completely correct in one
// tab. It only shows up with a second person on the canvas, whose edits arrive as a new
// prop and were silently dropped. Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Outliner from './canvas-components/Outliner';
import { ROOT, type OutlineNodes } from './outline-tree';

const tree = (...texts: string[]): OutlineNodes => {
  const nodes: OutlineNodes = { [ROOT]: { id: ROOT, text: '', children: [] } };
  texts.forEach((text, i) => {
    const id = `n${i}`;
    nodes[ROOT]?.children.push(id);
    nodes[id] = { id, text, children: [] };
  });
  return nodes;
};

const mount = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, rerender: (next: React.ReactElement) => act(() => root.render(next)) };
};

const rowValues = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('textarea')].map((t) => (t as HTMLTextAreaElement).value);

// The rows listen on onInput rather than onChange precisely so this works — React's
// onChange rides a value tracker happy-dom defeats (see ChatStarter for the same note).
const type = (el: HTMLTextAreaElement, value: string) => {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('Outliner shared state', () => {
  test("a collaborator's edit arrives as a new `nodes` prop and renders", () => {
    const { host, rerender } = mount(<Outliner nodes={tree('Coffee')} setData={() => {}} />);
    expect(rowValues(host)).toEqual(['Coffee']);

    // What the sync room delivers when someone else on the canvas types.
    rerender(<Outliner nodes={tree('Coffee', 'Oat milk')} setData={() => {}} />);
    expect(rowValues(host)).toEqual(['Coffee', 'Oat milk']);
  });

  test('an edit publishes the whole tree through setData — the shape is the source of truth', () => {
    const patches: Array<{ nodes?: OutlineNodes }> = [];
    const { host } = mount(<Outliner nodes={tree('Coffe')} setData={(p) => patches.push(p)} />);

    type(host.querySelector('textarea') as HTMLTextAreaElement, 'Coffee');

    expect(patches).toHaveLength(1);
    expect(patches[0]?.nodes?.n0?.text).toBe('Coffee');
  });

  test('an edit builds on the CURRENT prop, so it carries a collaborator’s row along', () => {
    // The clobber test. Under the old local mirror, an edit was composed against the tree
    // as it looked at mount — so publishing it erased every row someone else had added
    // since. Composed against the prop, their row rides along in the same patch.
    const patches: Array<{ nodes?: OutlineNodes }> = [];
    const { host, rerender } = mount(<Outliner nodes={tree('Coffee')} setData={(p) => patches.push(p)} />);
    rerender(<Outliner nodes={tree('Coffee', 'Oat milk')} setData={(p) => patches.push(p)} />);

    type(host.querySelector('textarea') as HTMLTextAreaElement, 'Decaf');

    expect(patches[0]?.nodes?.n0?.text).toBe('Decaf');
    expect(patches[0]?.nodes?.n1?.text).toBe('Oat milk');
  });

  test('the welcome outline has stable ids, so two viewers of an untouched card agree', () => {
    const a = mount(<Outliner setData={() => {}} />);
    const b = mount(<Outliner setData={() => {}} />);
    const ids = (host: HTMLElement) => [...host.querySelectorAll('[role="button"][title="Zoom in"]')].length;

    expect(rowValues(a.host)).toEqual(rowValues(b.host));
    expect(ids(a.host)).toBeGreaterThan(0);

    // Editing the seed publishes ids the other viewer already has on screen.
    const patches: Array<{ nodes?: OutlineNodes }> = [];
    const c = mount(<Outliner setData={(p) => patches.push(p)} />);
    type(c.host.querySelector('textarea') as HTMLTextAreaElement, 'Tea');
    expect(Object.keys(patches[0]?.nodes ?? {})).toEqual(['root', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
  });

  test('zoom is per-viewer view state, not shared — it never reaches setData', () => {
    const patches: unknown[] = [];
    const { host } = mount(<Outliner nodes={tree('Groceries')} setData={(p) => patches.push(p)} />);

    const bullet = host.querySelector('[role="button"][title="Zoom in"]') as HTMLElement;
    act(() => bullet.click());

    expect(host.textContent).toContain('Groceries'); // zoomed-in heading
    expect(patches).toHaveLength(0);
  });
});
