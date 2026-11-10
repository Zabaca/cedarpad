import { describe, expect, test } from 'bun:test';

import { ROOT, type OutlineNodes, flattenVisible, indent, mergeInto, outdent, pathTo, splitAt } from './outline-tree';

// Build a tree from an indented sketch, so each test reads as the outline it is about:
//   tree(['a', '  b', '  c'])  ⇒  a with children b, c
// Ids are the trimmed text, which keeps assertions legible.
function tree(lines: string[]): OutlineNodes {
  const nodes: OutlineNodes = { [ROOT]: { id: ROOT, text: '', children: [] } };
  const stack: string[] = [ROOT];
  for (const line of lines) {
    const depth = (line.length - line.trimStart().length) / 2;
    const text = line.trim();
    nodes[text] = { id: text, text, children: [] };
    stack.length = depth + 1;
    nodes[stack[depth] as string]?.children.push(text);
    stack.push(text);
  }
  return nodes;
}

const rows = (nodes: OutlineNodes, root = ROOT, showCompleted = true) =>
  flattenVisible(nodes, root, showCompleted).map((r) => '  '.repeat(r.depth) + r.id);

describe('flattenVisible', () => {
  test('walks the tree depth-first, carrying the indent depth', () => {
    expect(rows(tree(['a', '  b', '    c', 'd']))).toEqual(['a', '  b', '    c', 'd']);
  });

  test('a collapsed node keeps its row but hides its subtree', () => {
    const t = tree(['a', '  b', 'd']);
    t.a!.collapsed = true;
    expect(rows(t)).toEqual(['a', 'd']);
  });

  test('zooming renders a subtree at depth 0', () => {
    expect(rows(tree(['a', '  b', '    c', 'd']), 'a')).toEqual(['b', '  c']);
  });

  test('hiding completed items drops them', () => {
    const t = tree(['a', 'b']);
    t.b!.completed = true;
    expect(rows(t, ROOT, false)).toEqual(['a']);
    expect(rows(t, ROOT, true)).toEqual(['a', 'b']);
  });

  // `nodes` comes from shape data, which an agent can write. A child id with no node used
  // to be emitted anyway and reach the row renderer as `undefined`, crashing the card.
  test('a dangling child id is skipped, not rendered', () => {
    const t = tree(['a']);
    t[ROOT]!.children.push('ghost');
    expect(rows(t)).toEqual(['a']);
  });

  test('a cycle in persisted data terminates instead of hanging', () => {
    const t = tree(['a', '  b']);
    t.b!.children.push('a');
    expect(rows(t)).toEqual(['a', '  b']);
  });
});

describe('pathTo', () => {
  test('is the breadcrumb trail from below the root down to the node', () => {
    expect(pathTo(tree(['a', '  b', '    c']), 'c')).toEqual(['a', 'b', 'c']);
  });

  test('terminates on a cycle', () => {
    const t = tree(['a', '  b']);
    t.b!.children.push('a');
    expect(pathTo(t, 'b')).toEqual(['a', 'b']);
  });
});

describe('splitAt — Enter', () => {
  test('cuts the text at the caret and puts the tail in a new sibling', () => {
    const e = splitAt(tree(['hello world', 'next']), 'hello world', 5, 'n1');
    expect(e?.nodes['hello world']?.text).toBe('hello');
    expect(e?.nodes.n1?.text).toBe(' world');
    expect(rows(e!.nodes)).toEqual(['hello world', 'n1', 'next']);
    expect(e?.focus).toEqual({ id: 'n1', caret: 0 });
  });

  // Otherwise typing a heading and pressing Enter drops you out of the list you just began.
  test('on a node with visible children the new node becomes the first child', () => {
    const e = splitAt(tree(['a', '  b']), 'a', 1, 'n1');
    expect(rows(e!.nodes)).toEqual(['a', '  n1', '  b']);
  });

  test('on a COLLAPSED parent it becomes the next sibling — its children are not on screen', () => {
    const t = tree(['a', '  b']);
    t.a!.collapsed = true;
    expect(rows(splitAt(t, 'a', 1, 'n1')!.nodes)).toEqual(['a', 'n1']);
  });
});

describe('indent — Tab', () => {
  test('nests the node under its previous sibling', () => {
    expect(rows(indent(tree(['a', 'b']), 'b', 0)!.nodes)).toEqual(['a', '  b']);
  });

  test('expands a collapsed new parent so the nested node stays visible', () => {
    const t = tree(['a', '  x', 'b']);
    t.a!.collapsed = true;
    expect(rows(indent(t, 'b', 0)!.nodes)).toEqual(['a', '  x', '  b']);
  });

  test('is refused for a first child — there is no previous sibling', () => {
    expect(indent(tree(['a', 'b']), 'a', 0)).toBeNull();
  });
});

describe('outdent — Shift+Tab', () => {
  test('lifts the node to sit just after its parent', () => {
    expect(rows(outdent(tree(['a', '  b', '  c']), 'b', 0, ROOT)!.nodes)).toEqual(['a', '  c', 'b']);
  });

  test('is refused at the top level', () => {
    expect(outdent(tree(['a']), 'a', 0, ROOT)).toBeNull();
  });

  // Zoomed into `a`, outdenting `c` would otherwise move it out of view entirely.
  test('is refused at the view root, so a bullet cannot escape the zoomed subtree', () => {
    expect(outdent(tree(['a', '  b', '    c']), 'b', 0, 'a')).toBeNull();
    expect(rows(outdent(tree(['a', '  b', '    c']), 'c', 0, 'a')!.nodes, 'a')).toEqual(['b', 'c']);
  });
});

describe('mergeInto — Backspace at the start of a row', () => {
  test('folds the text onto the row above and deletes the node', () => {
    const e = mergeInto(tree(['foo', 'bar']), 'foo', 'bar');
    expect(e?.nodes.foo?.text).toBe('foobar');
    expect(e?.nodes.bar).toBeUndefined();
    expect(e?.focus).toEqual({ id: 'foo', caret: 3 });
    expect(rows(e!.nodes)).toEqual(['foo']);
  });

  test('the merged node donates its children rather than orphaning them', () => {
    const e = mergeInto(tree(['foo', 'bar', '  kid']), 'foo', 'bar');
    expect(rows(e!.nodes)).toEqual(['foo', '  kid']);
  });

  test('merging a first child into its own parent leaves the parent intact', () => {
    const e = mergeInto(tree(['a', '  b']), 'a', 'b');
    expect(e?.nodes.a?.text).toBe('ab');
    expect(rows(e!.nodes)).toEqual(['a']);
  });
});
