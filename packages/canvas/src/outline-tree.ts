// The tree algebra behind the Outliner component: a node map plus the four edits that
// move a bullet around in it (split, indent, outdent, merge-back). Pure — every function
// takes a node map and returns a NEW one, so the whole outliner's semantics are unit
// testable without a DOM, and the component is left as rendering plus focus bookkeeping.
//
// It lives out here rather than in `canvas-components/Outliner.tsx` for the same reason
// `chart-fit.ts` does: a non-component export from a `.tsx` downgrades every edit of that
// file to a full page reload under React Fast Refresh.

export const ROOT = 'root';

export type OutlineNode = {
  id: string;
  text: string;
  collapsed?: boolean;
  completed?: boolean;
  // `undefined` = no description; `''` = an open, empty one (Shift+Enter opens it).
  note?: string;
  children: string[];
};

export type OutlineNodes = Record<string, OutlineNode>;

/** A row as rendered: which node, and how deep below the current view root. */
export type VisibleRow = { id: string; depth: number };

/** The result of an edit: the new tree plus where the caret should land. `null` = refused
 *  (e.g. indenting the first child, which has no previous sibling to nest under). */
export type Edit = { nodes: OutlineNodes; focus: { id: string; caret: number } } | null;

const clone = (nodes: OutlineNodes): OutlineNodes => JSON.parse(JSON.stringify(nodes)) as OutlineNodes;

/** The node that lists `id` among its children, or undefined at (or above) the root. */
export function parentOf(nodes: OutlineNodes, id: string): OutlineNode | undefined {
  for (const k in nodes) if (nodes[k]?.children.includes(id)) return nodes[k];
  return undefined;
}

/** The ids from just below ROOT down to `id`, inclusive — the breadcrumb trail. */
export function pathTo(nodes: OutlineNodes, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = id;
  // `seen` guards against a cycle in persisted data: this map is agent-writable, and a
  // node reachable from its own descendant would otherwise spin here forever.
  while (cur && cur !== ROOT && !seen.has(cur)) {
    seen.add(cur);
    path.unshift(cur);
    cur = parentOf(nodes, cur)?.id ?? ROOT;
  }
  return path;
}

/** The rows to render under `rootId`, in order, skipping collapsed subtrees. A child id
 *  with no node is SKIPPED rather than emitted: `nodes` arrives from shape data an agent
 *  can write, and a dangling id used to reach the row renderer and throw. */
export function flattenVisible(nodes: OutlineNodes, rootId: string, showCompleted: boolean): VisibleRow[] {
  const out: VisibleRow[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (id: string, depth: number) => {
    const n = nodes[id];
    if (!n) return;
    for (const cid of n.children) {
      const child = nodes[cid];
      if (!child || seen.has(cid)) continue;
      if (!showCompleted && child.completed) continue;
      seen.add(cid);
      out.push({ id: cid, depth });
      if (child.children.length && !child.collapsed) walk(cid, depth + 1);
    }
  };
  walk(rootId, 0);
  return out;
}

/**
 * Enter: cut `id`'s text at the caret and put the tail in a new node `newId`.
 *
 * On a node with visible children the new node becomes its FIRST CHILD, not its next
 * sibling — otherwise typing a heading and pressing Enter drops you out of the list you
 * were building. The caller supplies `newId` so this stays pure.
 */
export function splitAt(nodes: OutlineNodes, id: string, caret: number, newId: string): Edit {
  const n = clone(nodes);
  const node = n[id];
  if (!node) return null;
  const after = node.text.slice(caret);
  node.text = node.text.slice(0, caret);
  n[newId] = { id: newId, text: after, children: [] };
  if (node.children.length && !node.collapsed) {
    node.children.unshift(newId);
  } else {
    const p = parentOf(n, id);
    if (!p) return null;
    p.children.splice(p.children.indexOf(id) + 1, 0, newId);
  }
  return { nodes: n, focus: { id: newId, caret: 0 } };
}

/** Tab: nest `id` under its previous sibling, expanding that sibling so it stays visible. */
export function indent(nodes: OutlineNodes, id: string, caret: number): Edit {
  const n = clone(nodes);
  const p = parentOf(n, id);
  if (!p) return null;
  const i = p.children.indexOf(id);
  if (i <= 0) return null; // first child — nothing to nest under
  const prev = n[p.children[i - 1] as string];
  if (!prev) return null;
  p.children.splice(i, 1);
  prev.children.push(id);
  prev.collapsed = false;
  return { nodes: n, focus: { id, caret } };
}

/** Shift+Tab: lift `id` to sit just after its parent. Refused at `viewRoot`, so outdenting
 *  can never climb a bullet out of the subtree you have zoomed into. */
export function outdent(nodes: OutlineNodes, id: string, caret: number, viewRoot: string): Edit {
  const n = clone(nodes);
  const p = parentOf(n, id);
  if (!p || p.id === viewRoot || p.id === ROOT) return null;
  const g = parentOf(n, p.id);
  if (!g) return null;
  p.children.splice(p.children.indexOf(id), 1);
  g.children.splice(g.children.indexOf(p.id) + 1, 0, id);
  return { nodes: n, focus: { id, caret } };
}

/** Backspace at position 0: fold `id`'s text and children onto `targetId` (the row above)
 *  and delete it. Focus lands at the seam, where the caret already visually was. */
export function mergeInto(nodes: OutlineNodes, targetId: string, id: string): Edit {
  const n = clone(nodes);
  const target = n[targetId];
  const cur = n[id];
  if (!target || !cur || targetId === id) return null;
  const caret = target.text.length;
  target.text += cur.text;
  target.children.push(...cur.children);
  const p = parentOf(n, id);
  if (p) p.children.splice(p.children.indexOf(id), 1);
  delete n[id];
  return { nodes: n, focus: { id: targetId, caret } };
}
