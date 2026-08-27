// An Ilograph-style architecture diagram: one declarative model, many perspectives.
//
// Ilograph's idea is that a system has no single correct diagram. You describe the
// resources once — nested, like the system actually is — and then describe several
// PERSPECTIVES over them, each a named set of relations. Switching perspective
// redraws the same resources with a different set of arrows; expanding a resource
// reveals its children and the relations re-route to whatever level is on screen.
//
// This card renders that model flow-first: relations are lit ribbons with traffic
// moving along them, and a `sequence` perspective (a request path, in order) is a
// first-class mode you can step or play through, not a footnote.
//
// Layout is computed — the spec carries no coordinates. Nodes are assigned to layers by
// longest path over the current perspective's relations, ordered within each layer to cut
// edge crossings, then stacked into columns.
//
// The surface is an INFINITE CANVAS. The viewBox is a fixed window and the camera (pan/zoom,
// by wheel, drag, or the +/−/Fit controls) is the only transform; nodes live at world
// coordinates beneath it, negative ones included. Nothing about the drawing's size feeds
// back into its scale — which is the point. The earlier version derived the viewBox from
// the content extents, so anything that grew them rescaled everything on screen: dragging a
// node shrank the node under the cursor and set the rest of the diagram drifting. Content
// extents are still computed, but they are read only by `fitCamera`, and only when someone
// asks to be re-framed.
//
// State splits on what it MEANS, and the split is the design.
//
// WHAT THE DIAGRAM SAYS is shared. Perspective, expansion, selection and sequence step
// round-trip through `setData`, so the card is a shared surface: what one viewer opens or
// steps to, every collaborator sees, and it survives a reload.
//
// HOW YOU ARE LOOKING AT IT is yours. The camera (pan/zoom) and any nodes you have dragged
// aside are local to the tab — not synced, not persisted, keyed per perspective. Both were
// once shared, and it was wrong for the same reason in both cases: zooming into a corner to
// study it dragged everyone else's view along with you. An arrangement, or a vantage point,
// is one reader's aid to their own reading and says nothing about the system.
//
// Two consequences worth naming. A perspective you have not opened is FITTED (`fitCamera`);
// one you have visited is left exactly where you left it, because carrying a camera between
// perspectives of different sizes lands you somewhere arbitrary. And dragging stays a
// hybrid: a dragged node pins while every other node keeps its computed place, so moving one
// box never stops the rest from re-laying out.

import type * as React from 'react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export type Resource = { id: string; name: string; sub?: string; color?: string; children?: Resource[] };
export type Relation = { from: string; to: string; label?: string };
export type Perspective = { id: string; name: string; desc?: string; sequence?: boolean; relations: Relation[] };

type Box = { x: number; y: number; w: number; h: number };
type VisibleNode = { id: string; name: string; sub?: string; color?: string; hasChildren: boolean };
export type ResolvedEdge = { from: string; to: string; label?: string };

const C = {
  bg: '#0c0e14',
  header: '#0c0e14',
  panel: '#101520',
  line: '#232936',
  text: '#e6ebf5',
  muted: '#5a6173',
  dim: '#6f7686',
  active: '#ffd479',
};
const NW = 140, NH = 50, GX = 96, GY = 34, PAD = 40;
// Pointer travel (in node coordinates) below which a gesture is still a click, not a drag.
const DRAG_SLOP = 3;
// The window the camera looks through, in world units. FIXED — it is not derived from the
// content, and that is the whole point: a viewBox computed from the extents means anything
// that grows them rescales the entire drawing, which is what made dragging a node feel
// rubbery. With a constant window, growth changes nothing until you ask to re-fit.
//
// `preserveAspectRatio="…meet"` guarantees the whole viewBox is visible at any card size or
// aspect, so content fitted into these bounds is content the reader can actually see — no
// element measurement, no ResizeObserver, and the same framing for every viewer.
const VIEW_W = 1000, VIEW_H = 700;
const VIEW = { w: VIEW_W, h: VIEW_H };
/** Room left around the content when fitting, so nodes are not flush to the edge. */
const FIT_MARGIN = 48;
/** Shared empty map, so an un-arranged perspective does not get a new object each render. */
const EMPTY_POSITIONS: Record<string, { x: number; y: number }> = {};

// ---------------------------------------------------------------- pure model ops

/** Flat lookup + child→parent map for a resource tree. Children inherit the parent's colour. */
export function indexModel(resources: Resource[]) {
  const byId: Record<string, Resource> = {};
  const parentOf: Record<string, string> = {};
  for (const r of resources) {
    byId[r.id] = r;
    for (const c of r.children ?? []) {
      byId[c.id] = { ...c, color: c.color ?? r.color };
      parentOf[c.id] = r.id;
    }
  }
  return { byId, parentOf };
}

/** The resources currently on screen: an expanded parent is replaced by its children. */
export function visibleNodes(resources: Resource[], expanded: Record<string, boolean>): VisibleNode[] {
  const out: VisibleNode[] = [];
  for (const r of resources) {
    if (expanded[r.id] && r.children?.length) {
      for (const c of r.children) out.push({ id: c.id, name: c.name, sub: c.sub, color: c.color ?? r.color, hasChildren: false });
    } else {
      out.push({ id: r.id, name: r.name, sub: r.sub, color: r.color, hasChildren: !!r.children?.length });
    }
  }
  return out;
}

/** Re-point one relation endpoint at the nearest resource that is actually visible:
 *  itself, else its parent (collapsed), else its first visible child (expanded). */
function toVisible(id: string, vis: Set<string>, byId: Record<string, Resource>, parentOf: Record<string, string>): string | null {
  if (vis.has(id)) return id;
  const p = parentOf[id];
  if (p && vis.has(p)) return p;
  const child = byId[id]?.children?.find((c) => vis.has(c.id));
  return child ? child.id : null;
}

/** A perspective's relations, re-routed to the visible level and deduped. Relations that
 *  collapse onto a single node (both ends inside one collapsed parent) disappear. */
export function resolveRelations(
  relations: Relation[],
  nodes: VisibleNode[],
  byId: Record<string, Resource>,
  parentOf: Record<string, string>,
): ResolvedEdge[] {
  const vis = new Set(nodes.map((n) => n.id));
  const seen = new Map<string, ResolvedEdge>();
  const out: ResolvedEdge[] = [];
  for (const rel of relations) {
    const from = toVisible(rel.from, vis, byId, parentOf);
    const to = toVisible(rel.to, vis, byId, parentOf);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const prior = seen.get(key);
    if (prior) { if (rel.label && !prior.label) prior.label = rel.label; continue; }
    const edge: ResolvedEdge = { from, to, label: rel.label };
    seen.set(key, edge);
    out.push(edge);
  }
  return out;
}

/** The resources this perspective actually says something about.
 *
 *  A perspective is a VIEW of the model, not an inventory of it: describe the resources
 *  once and each perspective relates the slice it is about, so a model always carries more
 *  than any single perspective wires up. Without this, those extras still drew — and since
 *  `layerNodes` gives an unconnected node layer 0, they collected in a column at the far
 *  left, which reads as a diagram of something rather than as absence.
 *
 *  Pruned AFTER `resolveRelations`, never before: re-routing is what decides whether a
 *  resource is involved at the level currently on screen — a collapsed parent is connected
 *  by its children's relations, and expanding it can make some of those children irrelevant.
 *
 *  No edges at all is the one case that keeps everything. That is not "nothing is
 *  relevant", it is nothing to be relevant TO, and pruning against it empties the card. */
export function connectedNodes(nodes: VisibleNode[], edges: ResolvedEdge[]): VisibleNode[] {
  if (!edges.length) return nodes;
  const touched = new Set<string>();
  for (const e of edges) { touched.add(e.from); touched.add(e.to); }
  return nodes.filter((n) => touched.has(n.id));
}

/**
 * Everything upstream and downstream of the selection — what leads to it, and what follows
 * from it, however far — or null when nothing is selected.
 *
 * TRANSITIVE, so selecting any step of a pipeline lights the pipeline end to end. But
 * DIRECTED, which is the part that is easy to get wrong: an undirected walk reaches a
 * resource's SIBLINGS by going up to a shared parent and back down a different branch, and
 * a sibling is not related to you. On the doc model, `packages/flags` should light
 * `delivery.md`, `CONTEXT.md` and `AGENTS.md` — the line that arrives at it — and leave
 * `standards.md`, `issue-tracker.md` and `testing.md` dark. Undirected lights all seven and
 * says nothing.
 *
 * Note what this gives up, correctly: members of one lineage do NOT all answer with the same
 * set. `standards.md` answers with two nodes and `packages/flags` with four. Only on a
 * straight line does every member agree, which is exactly why a linear perspective is a bad
 * place to decide this rule.
 */
export function lineage(edges: ResolvedEdge[], selected: string | null): Set<string> | null {
  if (!selected) return null;
  // TWO closures, kept apart and then unioned. Following relations in both directions from
  // every node reached — one combined walk — is what collapses this back into the undirected
  // component, and re-admits the siblings.
  const walk = (next: (e: ResolvedEdge) => [string, string]) => {
    const seen = new Set<string>([selected]);
    // Re-sweeps until nothing new appears, rather than building an adjacency index: an edge
    // set this size is nowhere near worth one, and the loop is obviously correct.
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of edges) {
        const [at, to] = next(e);
        if (seen.has(at) && !seen.has(to)) { seen.add(to); grew = true; }
      }
    }
    return seen;
  };
  const up = walk((e) => [e.to, e.from]);
  const down = walk((e) => [e.from, e.to]);
  return new Set([...up, ...down]);
}

/** How many down-up sweeps the ordering below runs. Four is the usual stopping point for
 *  the median heuristic: the first two do nearly all the work and it converges after that. */
const ORDER_PASSES = 4;

/**
 * Order each column so its edges cross as little as possible — the crossing-reduction step
 * of a Sugiyama layout, by the median heuristic.
 *
 * Layering alone decides which COLUMN a node is in; it says nothing about the order WITHIN
 * one, and taking that from the model was what produced the hairball: on the skills model's
 * "Doc reads" the seven readers sit in authoring order while their targets do not, crossing
 * ten times. Ordering each reader by the median position of what it points at drops that to
 * zero without moving a single node to a different column.
 *
 * A node with no neighbour in the reference column keeps its current index instead: the
 * heuristic has nothing to place it BY, and inventing a position would fling unrelated
 * resources to an arbitrary end. Sorting is stable, so equal keys hold their relative order
 * and a settled layout stops moving.
 */
export function orderColumns(columns: VisibleNode[][], edges: ResolvedEdge[]): VisibleNode[][] {
  const preds: Record<string, string[]> = {};
  const succs: Record<string, string[]> = {};
  for (const e of edges) {
    (succs[e.from] ??= []).push(e.to);
    (preds[e.to] ??= []).push(e.from);
  }

  const indexOf = (col: VisibleNode[]) => {
    const at: Record<string, number> = {};
    col.forEach((n, i) => { at[n.id] = i; });
    return at;
  };

  const median = (ids: string[] | undefined, at: Record<string, number>): number | null => {
    const ps = (ids ?? []).map((id) => at[id]).filter((p): p is number => p !== undefined).sort((a, b) => a - b);
    if (!ps.length) return null;
    const m = ps.length >> 1;
    return ps.length % 2 ? ps[m]! : (ps[m - 1]! + ps[m]!) / 2;
  };

  const sweep = (col: VisibleNode[], ref: Record<string, number>, adj: Record<string, string[]>) => {
    const key: Record<string, number> = {};
    col.forEach((n, i) => { key[n.id] = median(adj[n.id], ref) ?? i; });
    return [...col].sort((a, b) => key[a.id]! - key[b.id]!);
  };

  const out = columns.map((c) => [...c]);
  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    for (let i = 1; i < out.length; i++) out[i] = sweep(out[i]!, indexOf(out[i - 1]!), preds);
    for (let i = out.length - 2; i >= 0; i--) out[i] = sweep(out[i]!, indexOf(out[i + 1]!), succs);
  }
  return out;
}

/** Longest-path layering, then a centred column stack. Iteration-capped, so a cycle in the
 *  relations settles instead of looping forever. */
export function layerNodes(nodes: VisibleNode[], edges: ResolvedEdge[]) {
  const layer: Record<string, number> = {};
  for (const n of nodes) layer[n.id] = 0;
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (layer[e.to] === undefined || layer[e.from] === undefined) continue;
      if (layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; moved = true; }
    }
    if (!moved) break;
  }
  const columns = new Map<number, VisibleNode[]>();
  for (const n of nodes) {
    const col = columns.get(layer[n.id]) ?? [];
    col.push(n);
    columns.set(layer[n.id], col);
  }
  const keys = [...columns.keys()].sort((a, b) => a - b);
  // Compacted to a dense left-to-right array FIRST: the ordering below treats neighbouring
  // array entries as neighbouring columns, which is only true once gaps in the layer
  // numbers are gone.
  const ordered = orderColumns(keys.map((k) => columns.get(k)!), edges);
  const tallest = Math.max(1, ...ordered.map((c) => c.length));
  const width = keys.length * NW + (keys.length - 1) * GX;
  const height = tallest * NH + (tallest - 1) * GY;
  const pos: Record<string, Box> = {};
  ordered.forEach((col, ci) => {
    const colH = col.length * NH + (col.length - 1) * GY;
    col.forEach((n, ri) => {
      pos[n.id] = { x: ci * (NW + GX), y: (height - colH) / 2 + ri * (NH + GY), w: NW, h: NH };
    });
  });
  return { pos, width, height };
}

/**
 * Overlay hand-placed node positions onto a computed layout.
 *
 * Dragging is deliberately a HYBRID rather than a switch to manual: a dragged node pins,
 * every other node keeps the position layering gave it. Freezing the whole layout on the
 * first drag would mean moving one box silently stops the diagram from re-laying out when
 * you change perspective or open a resource.
 *
 * An override for a node the layout did not place is IGNORED, and cannot stretch the
 * drawing. Perspectives and expansion change the node set under a saved position all the
 * time, and a stale one must not resurrect a node that is not on screen.
 *
 * `origin` is the top-left of everything occupied, which is negative once a node is dragged
 * above or left of where layering starts. The caller offsets the drawing by it so that space
 * is inside the viewBox instead of clipped away.
 */
export function applyPositions(
  pos: Record<string, Box>,
  overrides: Record<string, { x: number; y: number }> | undefined,
): { pos: Record<string, Box>; width: number; height: number; origin: { x: number; y: number } } {
  const out: Record<string, Box> = {};
  for (const [id, box] of Object.entries(pos)) {
    const o = overrides?.[id];
    out[id] = o ? { ...box, x: o.x, y: o.y } : box;
  }
  const boxes = Object.values(out);
  if (!boxes.length) return { pos: out, width: 0, height: 0, origin: { x: 0, y: 0 } };
  const origin = {
    x: Math.min(0, ...boxes.map((b) => b.x)),
    y: Math.min(0, ...boxes.map((b) => b.y)),
  };
  return {
    pos: out,
    width: Math.max(...boxes.map((b) => b.x + b.w)) - origin.x,
    height: Math.max(...boxes.map((b) => b.y + b.h)) - origin.y,
    origin,
  };
}

/**
 * The camera that brings a drawing of this size into view, centred.
 *
 * This is the "start centred" half of an infinite canvas: extents are consumed HERE, once,
 * on an explicit occasion — first open, a perspective change, or the Fit button — instead of
 * every frame. That is the difference that matters. When the frame is derived from content
 * continuously, moving a node changes the scale of everything including the node under the
 * cursor; when it is derived on demand, the canvas simply holds still and the reader decides
 * when to re-frame.
 *
 * It never magnifies past 1:1. Blowing a three-box diagram up to fill a card makes it look
 * like a different, bigger thing, and the node sizes stop being comparable between
 * perspectives.
 */
export function fitCamera(
  content: { width: number; height: number; origin: { x: number; y: number } },
  view: { w: number; h: number },
  margin = FIT_MARGIN,
): { zoom: number; pan: { x: number; y: number } } {
  const room = { w: Math.max(1, view.w - margin * 2), h: Math.max(1, view.h - margin * 2) };
  const zoom = content.width > 0 && content.height > 0
    ? Math.min(1, room.w / content.width, room.h / content.height)
    : 1;
  return {
    zoom,
    pan: {
      x: view.w / 2 - zoom * (content.origin.x + content.width / 2),
      y: view.h / 2 - zoom * (content.origin.y + content.height / 2),
    },
  };
}

/** A ribbon between two boxes: a forward S-curve, or a loop under both when it goes backwards. */
export function ribbonPath(a: Box, b: Box): string {
  const ax = a.x + a.w, ay = a.y + a.h / 2, bx = b.x, by = b.y + b.h / 2;
  if (bx > ax) {
    const bend = (bx - ax) * 0.55;
    return `M${ax},${ay} C${ax + bend},${ay} ${bx - bend},${by} ${bx},${by}`;
  }
  const under = Math.max(a.y + a.h, b.y + b.h) + 34;
  const sx = a.x + a.w / 2, tx = b.x + b.w / 2;
  return `M${sx},${a.y + a.h} C${sx},${under} ${tx},${under} ${tx},${b.y + b.h}`;
}

// -------------------------------------------------------------- default model

// Placed with no model, the card documents the system it is running inside — which
// doubles as the worked example an agent copies to author its own (ADR-0018 … 0023).
const DEFAULT_RESOURCES: Resource[] = [
  { id: 'browser', name: 'Browser', sub: 'client surfaces', color: '#4f9cf9', children: [
    { id: 'shell', name: 'Shell SPA', sub: 'rail + stages' },
    { id: 'pad', name: 'Render Pad', sub: 'same-origin iframe' },
  ] },
  { id: 'edge', name: 'Edge Worker', sub: 'Cloudflare', color: '#2dd4bf', children: [
    { id: 'auth', name: 'Better Auth', sub: 'magic link' },
    { id: 'api', name: 'Platform API', sub: 'RPC' },
    { id: 'proxy', name: 'DB proxy', sub: 'forwarded rows' },
  ] },
  { id: 'do', name: 'Durable Object', sub: 'one per canvas', color: '#a78bfa', children: [
    { id: 'room', name: 'TLSocketRoom', sub: 'tldraw sync' },
    { id: 'dosql', name: 'DO SQLite', sub: 'room state' },
  ] },
  { id: 'container', name: 'Container', sub: 'workspace runtime', color: '#fb923c', children: [
    { id: 'bridge', name: 'Bridge', sub: 'chat owner' },
    { id: 'sdk', name: 'Claude SDK', sub: 'agent loop' },
  ] },
  { id: 'd1', name: 'D1', sub: 'platform data layer', color: '#f472b6' },
  { id: 'r2', name: 'R2', sub: 'blobs', color: '#4ade80' },
];

const DEFAULT_PERSPECTIVES: Perspective[] = [
  { id: 'runtime', name: 'Runtime', desc: 'Who talks to whom at request time.', relations: [
    { from: 'shell', to: 'api', label: 'fetch' },
    { from: 'shell', to: 'auth', label: 'session' },
    { from: 'pad', to: 'room', label: 'websocket' },
    { from: 'pad', to: 'bridge', label: 'chat SSE' },
    { from: 'api', to: 'proxy' },
    { from: 'proxy', to: 'd1', label: 'sql' },
    { from: 'room', to: 'dosql', label: 'persist' },
    { from: 'bridge', to: 'sdk', label: 'turn' },
    { from: 'bridge', to: 'api', label: 'writes back' },
    { from: 'api', to: 'r2', label: 'blobs' },
  ] },
  { id: 'data', name: 'Data', desc: 'Where state actually lives — ADR-0018 / 0019 / 0022.', relations: [
    { from: 'browser', to: 'edge', label: 'reads' },
    { from: 'edge', to: 'd1', label: 'records' },
    { from: 'edge', to: 'r2', label: 'blobs' },
    { from: 'do', to: 'dosql', label: 'canvas doc' },
    { from: 'container', to: 'edge', label: 'no db client' },
  ] },
  { id: 'turn', name: 'Chat turn', desc: 'One message, end to end.', sequence: true, relations: [
    { from: 'pad', to: 'api', label: 'POST send' },
    { from: 'api', to: 'bridge', label: 'forward' },
    { from: 'bridge', to: 'sdk', label: 'run turn' },
    { from: 'sdk', to: 'bridge', label: 'blocks' },
    { from: 'bridge', to: 'proxy', label: 'persist' },
    { from: 'proxy', to: 'd1', label: 'write' },
    { from: 'bridge', to: 'pad', label: 'stream SSE' },
  ] },
];

// ------------------------------------------------------------------ component

type View = {
  perspective: string;
  expanded: Record<string, boolean>;
  selected: string | null;
  step: number;
};

/** Where one perspective is being looked at from. Local to the tab — see the header. */
type Camera = { zoom: number; pan: { x: number; y: number } };

export default function IlographDiagram(props: {
  resources?: Resource[];
  perspectives?: Perspective[];
  accent?: string;
  perspective?: string;
  expanded?: Record<string, boolean>;
  selected?: string | null;
  step?: number;
  setData?: (patch: Record<string, unknown>) => void;
  /** Injected by ComponentHost: true only where no shape guard sits between us and the
   *  pointer — fullscreen and component-guest. See the camera comment below. */
  unguarded?: boolean;
  [k: string]: unknown;
}) {
  const { setData, accent = '#4a9eff', unguarded = false } = props;
  const resources = props.resources?.length ? props.resources : DEFAULT_RESOURCES;
  const perspectives = props.perspectives?.length ? props.perspectives : DEFAULT_PERSPECTIVES;

  // With a host, `data` IS the state and setData is the only writer, so every viewer
  // sees the same thing. Standalone (no host) the same card still works, locally.
  const [local, setLocal] = useState<Partial<View>>({});
  const fromProps: View = {
    perspective: props.perspective ?? perspectives[0].id,
    expanded: props.expanded ?? {},
    selected: props.selected ?? null,
    step: props.step ?? 0,
  };
  const view: View = setData ? fromProps : { ...fromProps, ...local };
  const commit = (patch: Partial<View>) => (setData ? setData(patch) : setLocal((v) => ({ ...v, ...patch })));

  // The perspective on screen keys every piece of local state below, so it is resolved first.
  const current = perspectives.find((p) => p.id === view.perspective) ?? perspectives[0];

  // The camera is LOCAL and per perspective, and never goes through `setData`.
  //
  // Sharing it was wrong twice over. It moved other people's view: a reader zooming in to
  // study one corner dragged every other viewer's diagram there with them, which is the same
  // objection that already keeps node dragging local — what the diagram SAYS is shared, how
  // you are looking at it is yours. And keying it per perspective is what makes switching
  // sane: perspectives differ in size and shape, so carrying one's camera into the next
  // lands you somewhere arbitrary. Each perspective now remembers where you were, and a
  // perspective you have not opened yet gets fitted.
  //
  // Local state also deletes the debounce this used to need. The optimistic `interim`
  // overlay, its pending ref and its commit timer existed to hide a `setData` round-trip —
  // and were the direct cause of a camera that would not change: `interim` was set on every
  // pan and never cleared, so it permanently shadowed the committed value and a fit computed
  // on a perspective change was simply never displayed.
  const svgRef = useRef<SVGSVGElement>(null);
  const [cameras, setCameras] = useState<Record<string, Camera>>({});
  const dragRef = useRef<{ pointerId: number; startLocal: { x: number; y: number }; startPan: { x: number; y: number } } | null>(null);

  // Whether this host lets us run a camera at all. On a CARD the shape's event guard
  // swallows wheel before it reaches us and hands a background pointerdown to tldraw
  // mid-gesture — so a wheel-zoom silently does nothing, and a background pan both drags
  // the card and never receives its own pointerup, leaving the diagram panning on every
  // mouse move until reload. This is what the base card's original comment meant by
  // owning no pan/zoom "so tldraw's canvas zoom keeps working": not a preference, a
  // constraint. Fullscreen has no guard, so there the camera is real.
  const camera = cameras[current.id];
  const zoom = camera?.zoom ?? 1;
  const pan = camera?.pan ?? { x: 0, y: 0 };
  const setCamera = (c: Camera) => setCameras((m) => ({ ...m, [current.id]: c }));

  /** Client coords -> the SVG's own viewBox space (unaffected by our pan/zoom group), via
   *  getScreenCTM — the same space `pan` is expressed in, so drag deltas need no zoom scaling. */
  const toLocal = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const newZoom = Math.max(0.25, Math.min(4, zoom * factor));
    if (newZoom === zoom) return;
    const p = toLocal(clientX, clientY);
    const newPan = {
      x: p.x - (newZoom / zoom) * (p.x - pan.x),
      y: p.y - (newZoom / zoom) * (p.y - pan.y),
    };
    setCamera({ zoom: newZoom, pan: newPan });
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;

  // Wheel needs a non-passive native listener — React's onWheel is passive by default, so
  // preventDefault() there is a no-op and the page/canvas would scroll instead of zooming.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !unguarded) return; // on a card the guard consumes wheel before we see it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtRef.current(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [unguarded]);


  // Hand-placed node positions are LOCAL and per perspective, exactly like the camera:
  // per tab, gone on reload, never written through setData. Unlike perspective/expansion/
  // step, an arrangement is one reader's aid to their own reading, not a statement about the
  // system, so pushing it at collaborators would move their diagram to suit someone else's
  // train of thought. Keyed per perspective so returning to one you have arranged finds it
  // as you left it, rather than reset.
  const [draggedBy, setDraggedBy] = useState<Record<string, Record<string, { x: number; y: number }>>>({});
  const dragged = draggedBy[current.id] ?? EMPTY_POSITIONS;
  const setDragged = (next: Record<string, { x: number; y: number }>) =>
    setDraggedBy((m) => ({ ...m, [current.id]: next }));
  // While the pointer is down we hold the position here and paint from it, so a drag tracks
  // the cursor at frame rate rather than through a state round-trip per move.
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null);
  const nodeDragRef = useRef<
    { pointerId: number; id: string; from: { x: number; y: number }; at: { x: number; y: number }; moved: boolean } | null
  >(null);
  // A drag ends with a click event the browser still fires; without this, letting go after
  // moving a resource would also toggle it open.
  const suppressClick = useRef(false);

  const { byId, parentOf } = indexModel(resources);
  const nodes = visibleNodes(resources, view.expanded);
  const edges = resolveRelations(current.relations, nodes, byId, parentOf);
  // Pruned against the perspective's WHOLE edge set, not the sequence's `drawn` prefix:
  // stepping is a walk through one path, and a node the path has not reached yet is dimmed
  // below, not absent. Dropping it per step would make the layout jump on every press.
  const shown = connectedNodes(nodes, edges);
  const laid = layerNodes(shown, edges).pos;
  const placed = dragging ? { ...dragged, [dragging.id]: { x: dragging.x, y: dragging.y } } : dragged;
  // Drawn from the live position, but FRAMED from the committed ones. Framing off the
  // live drag is a feedback loop: the node moves, the extents grow, `meet` scales the
  // whole drawing down to fit them, and the node shrinks away from the cursor it is
  // supposed to be following while every other node drifts. Frozen for the length of the
  // gesture, the diagram holds still and grows once, on release.
  // ONE call now. The drawn-vs-framed split existed only to stop a live drag from
  // rescaling the drawing, and with a fixed window there is no derived scale left to fight.
  // Extents survive as `content`, read only when something asks for a fit.
  const content = applyPositions(laid, placed);
  const pos = content.pos;

  const isSeq = !!current.sequence;
  const step = Math.max(0, Math.min(view.step, edges.length));
  // Step 0 idles the whole flow at low intensity; stepping lights it up in order.
  const idle = isSeq && step === 0;
  const cursor = isSeq && !idle ? step - 1 : -1;
  const drawn = isSeq && !idle ? edges.slice(0, step) : edges;
  // Selecting a resource asks "what leads here, and what follows?". Only the incident
  // ribbons used to respond, so the far end of a relation rendered exactly like an unrelated
  // node and the answer had to be traced along a line rather than read. Now the whole lineage
  // stays lit and everything else drops back, reusing the dimming sequence mode already uses
  // so the card has one visual language for "not part of what you are looking at".
  const near = lineage(edges, view.selected);
  const lit = new Set<string>();
  if (isSeq && !idle) for (const e of drawn) { lit.add(e.from); lit.add(e.to); }

  const [playing, setPlaying] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = stepRef.current + 1;
      if (next > edges.length) { setPlaying(false); return; }
      commit({ step: next });
    }, 1500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, edges.length]);
  useEffect(() => { if (!isSeq) setPlaying(false); }, [isSeq]);

  // Start centred, and re-centre when the model on screen becomes a different shape.
  //
  // Deliberately NOT every render: the camera is shared state, so fitting on every open
  // would have each viewer rewrite everyone's framing just by looking. It runs when there is
  // no stored camera at all (a card placed but never framed) and when the perspective
  // changes — the second is a click someone just made, so a re-frame is the expected answer
  // rather than a surprise. Any other time, the camera is the reader's and stays put.
  useEffect(() => {
    if (cameras[current.id]) return; // been here before — leave the reader where they were
    setCamera(fitCamera(content, VIEW));
    // `content` and `cameras` are intentionally out of the dep list: this fires when the
    // perspective changes, not when the layout does, and the guard above is what makes it
    // run once per perspective.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id]);

  const onNode = (id: string) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const patch: Partial<View> = { selected: view.selected === id ? null : id };
    if (byId[id]?.children?.length) patch.expanded = { ...view.expanded, [id]: !view.expanded[id] };
    setPlaying(false);
    commit(patch);
  };

  /** Node drag. The svg's own pan handler already ignores pointerdown on `[data-node]`, so
   *  the two never fight over the same gesture. Deltas are divided by `zoom` because node
   *  coordinates live INSIDE the scaled group while `toLocal` reports the space outside it. */
  const onNodeDown = (e: React.PointerEvent<SVGGElement>, id: string, at: Box) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    nodeDragRef.current = { pointerId: e.pointerId, id, from: toLocal(e.clientX, e.clientY), at: { x: at.x, y: at.y }, moved: false };
  };
  const onNodeMove = (e: React.PointerEvent<SVGGElement>) => {
    const d = nodeDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.buttons === 0) { nodeDragRef.current = null; setDragging(null); return; } // lost the release
    const cur = toLocal(e.clientX, e.clientY);
    const dx = (cur.x - d.from.x) / zoom;
    const dy = (cur.y - d.from.y) / zoom;
    // Below the slop a gesture is still a click — a resource opens on click, and a couple of
    // stray pixels must not turn that into a one-pixel move that also pins the node.
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    d.moved = true;
    setDragging({ id: d.id, x: d.at.x + dx, y: d.at.y + dy });
  };
  const onNodeUp = (e: React.PointerEvent<SVGGElement>) => {
    const d = nodeDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    nodeDragRef.current = null;
    if (d.moved && dragging) {
      suppressClick.current = true;
      setDragged({ ...dragged, [d.id]: { x: dragging.x, y: dragging.y } });
    }
    setDragging(null);
  };

  const colorOf = (id: string) => byId[id]?.color ?? accent;

  // Geometry resolved ONCE and drawn in two passes, because the two belong on opposite
  // sides of the nodes: ribbons behind them, labels in front. A label sits at the midpoint
  // between two columns, which is exactly where a node in an intermediate column stands, so
  // painting it with its ribbon put it BEHIND that node and clipped the text.
  const ribbons = drawn
    .map((e, i) => {
      const a = pos[e.from];
      const b = pos[e.to];
      if (!a || !b) return null;
      const on = i === cursor;
      const forward = b.x > a.x;
      return {
        i,
        label: e.label,
        on,
        faded: !!near && !(near.has(e.from) && near.has(e.to)),
        d: ribbonPath(a, b),
        col: on ? C.active : colorOf(e.from),
        lx: forward ? (a.x + a.w + b.x) / 2 : (a.x + b.x) / 2 + NW / 2,
        ly: forward ? (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 11 : Math.max(a.y + a.h, b.y + b.h) + 30,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
      background: C.bg, color: C.text, font: '13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", sans-serif', overflow: 'hidden' }}>

      {/* chrome stays LEFT — the shape's fullscreen button owns the top-right corner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', flexShrink: 0, background: C.header }}>
        <div style={{ display: 'inline-flex', gap: 2, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 2 }}>
          {perspectives.map((p) => {
            const on = p.id === current.id;
            return (
              <button key={p.id} type="button" onClick={() => { setPlaying(false); commit({ perspective: p.id, step: 0, selected: null }); }}
                aria-pressed={on}
                style={{ border: 0, background: on ? 'linear-gradient(180deg,#2b3a52,#1d2738)' : 'transparent',
                  color: on ? '#d9e7ff' : C.dim, borderRadius: 6, padding: '4px 12px', font: 'inherit', fontSize: 11.5, cursor: 'pointer',
                  boxShadow: on ? '0 1px 0 #40536f inset' : 'none' }}>
                {p.name}
              </button>
            );
          })}
        </div>
        <span style={{ color: C.muted, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.desc}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingRight: 34 }}>
          {isSeq && (
            <>
              <Btn onClick={() => { if (playing) { setPlaying(false); return; } if (step >= edges.length) commit({ step: 0 }); setPlaying(true); }}
                on={playing}>{playing ? '❚❚ Pause' : '▶ Play'}</Btn>
              <Btn onClick={() => { setPlaying(false); commit({ step: step - 1 }); }} disabled={step === 0}>‹</Btn>
              <Btn onClick={() => { setPlaying(false); commit({ step: step + 1 }); }} disabled={step >= edges.length}>›</Btn>
            </>
          )}
          {/* Zoom without pan is a trap — the buttons WOULD work on a card (they are real
              <button>s, so the guard lets them through) but wheel and background drag do not,
              leaving no way back to what scrolled off. So the whole cluster is fullscreen-only
              and a card keeps the framing it opened with. */}
          {unguarded && (
            <>
              <Btn onClick={() => {
                const r = svgRef.current?.getBoundingClientRect();
                zoomAt(1 / 1.2, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0);
              }}>−</Btn>
              <span style={{ color: C.dim, fontSize: 11, minWidth: 32, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <Btn onClick={() => {
                const r = svgRef.current?.getBoundingClientRect();
                zoomAt(1.2, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0);
              }}>+</Btn>
              <Btn onClick={() => { setDragged({}); setCamera(fitCamera(content, VIEW)); }}>Fit</Btn>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' }}
          onPointerDown={(e) => {
            // A background pointerdown belongs to tldraw on a card — taking it here starts a
            // pan the host immediately steals, and the stolen gesture never returns a
            // pointerup to end it.
            if (!unguarded) return;
            if ((e.target as Element).closest('[data-node]')) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { pointerId: e.pointerId, startLocal: toLocal(e.clientX, e.clientY), startPan: pan };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            // The button is already up: a pointerup went somewhere else (a host that claimed
            // the gesture, a release off-window). Without this the drag never ends and the
            // diagram pans on every mouse move until reload.
            if (e.buttons === 0) { dragRef.current = null; return; }
            const cur = toLocal(e.clientX, e.clientY);
            setCamera({ zoom, pan: { x: d.startPan.x + (cur.x - d.startLocal.x), y: d.startPan.y + (cur.y - d.startLocal.y) } });
          }}
          onPointerUp={(e) => {
            if (dragRef.current?.pointerId !== e.pointerId) return;
            dragRef.current = null;
          }}
          onPointerCancel={(e) => {
            if (dragRef.current?.pointerId !== e.pointerId) return;
            dragRef.current = null;
          }}>
          <defs>
            <filter id="ilo-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {/* The camera, and the only transform in the drawing. Nodes are at world
              coordinates underneath it — negative ones included, which an infinite canvas
              handles natively and a content-derived viewBox had to fold away. */}
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          <g>
            {ribbons.map((r) =>
              r.faded ? (
                <path key={r.i} d={r.d} fill="none" stroke="#1c2130" strokeWidth={7} strokeLinecap="round" />
              ) : (
                <g key={r.i}>
                  <path d={r.d} fill="none" stroke={r.col} strokeOpacity={r.on ? 0.28 : 0.13} strokeWidth={r.on ? 13 : 9} strokeLinecap="round" />
                  <path id={`ilo-r${r.i}`} d={r.d} fill="none" stroke={r.col} strokeOpacity={r.on ? 0.95 : 0.55} strokeWidth={r.on ? 2.2 : 1.4} />
                  {Array.from({ length: r.on ? 3 : 1 }, (_, k) => (
                    <circle key={k} r={r.on ? 3.4 : 2.2} fill={r.col} filter={r.on ? 'url(#ilo-glow)' : undefined}>
                      <animateMotion dur={r.on ? '1.6s' : '3s'} begin={`${(k * (r.on ? 0.53 : 1)).toFixed(2)}s`} repeatCount="indefinite">
                        <mpath href={`#ilo-r${r.i}`} />
                      </animateMotion>
                    </circle>
                  ))}
                </g>
              ),
            )}

            {shown.map((n) => {
              const q = pos[n.id];
              if (!q) return null;
              const col = n.color ?? accent;
              const hot = isSeq && !idle ? lit.has(n.id) : !near || near.has(n.id);
              const sel = view.selected === n.id;
              return (
                // role="button" is what lets the click through the shape's capture-phase
                // guard (src/predicates.ts) — a bare <g onClick> would silently never fire.
                <g key={n.id} role="button" tabIndex={0} data-node={n.id} onClick={() => onNode(n.id)}
                  onPointerDown={(e) => onNodeDown(e, n.id, q)} onPointerMove={onNodeMove}
                  onPointerUp={onNodeUp} onPointerCancel={onNodeUp}
                  style={{ cursor: dragging?.id === n.id ? 'grabbing' : 'grab', touchAction: 'none' }}
                  opacity={hot ? 1 : 0.3}>
                  <rect x={q.x} y={q.y} width={q.w} height={q.h} rx={12} fill="#141926"
                    stroke={sel ? col : `${col}44`} strokeWidth={sel ? 2 : 1.2} filter={sel ? 'url(#ilo-glow)' : undefined} />
                  <circle cx={q.x + 15} cy={q.y + q.h / 2} r={4} fill={col} />
                  <text x={q.x + 28} y={q.y + 21} fill={C.text} fontWeight={600} fontSize={11}>{n.name}</text>
                  {n.sub && <text x={q.x + 28} y={q.y + 36} fill={C.muted} fontSize={10}>{n.sub}</text>}
                  {n.hasChildren && (
                    <text x={q.x + q.w - 14} y={q.y + 20} fill={col} fontSize={13} opacity={0.7}>
                      {view.expanded[n.id] ? '−' : '+'}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Labels LAST, so one that lands over a node reads on top of it rather than
                behind. `paint-order: stroke` draws the background colour as a stroke first
                and the glyph fill over it — a knockout halo that separates the text from
                whatever ribbon runs beneath, without needing to measure the text to place a
                background plate. */}
            {ribbons.map((r) =>
              r.faded || !r.label ? null : (
                <text key={r.i} x={r.lx} y={r.ly} textAnchor="middle" fontSize={11}
                  fill={r.col} opacity={r.on ? 1 : 0.85}
                  stroke={C.bg} strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round">
                  {r.label}
                </text>
              ),
            )}
          </g>
          </g>
        </svg>
      </div>

      <div style={{ flexShrink: 0, padding: '8px 14px 11px', color: '#7a8090', fontSize: 12, minHeight: 34 }}>
        {isSeq
          ? (cursor < 0
            ? 'Press Play to watch this path cross the system.'
            : <><b style={{ color: C.active }}>{step} / {edges.length}</b>{'  '}
              {byId[edges[cursor].from]?.name} → {byId[edges[cursor].to]?.name}
              {edges[cursor].label ? ` · ${edges[cursor].label}` : ''}</>)
          : (view.selected
            ? <><b style={{ color: colorOf(view.selected) }}>{byId[view.selected]?.name}</b>
              {' — '}{edges.filter((e) => e.to === view.selected).length} inbound,{' '}
              {edges.filter((e) => e.from === view.selected).length} outbound</>
            : 'Click a resource to isolate its traffic; + opens it up.')}
      </div>
    </div>
  );
}

function Btn({ children, onClick, disabled, on }: { children: ReactNode; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ background: on ? '#163a30' : '#141926', border: `1px solid ${on ? '#2dd4bf' : '#262c3a'}`,
        color: on ? '#8fe9d6' : C.text, borderRadius: 7, padding: '4px 12px', font: 'inherit', fontSize: 11.5,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.3 : 1 }}>
      {children}
    </button>
  );
}
