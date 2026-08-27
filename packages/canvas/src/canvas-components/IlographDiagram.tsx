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
// Layout is computed — the spec carries no coordinates. Nodes are assigned to layers
// by longest path over the current perspective's relations, then stacked into columns
// and centred. The drawing fits the shape via the SVG viewBox; pan and zoom are a
// separate transform on top of that base layout (wheel/drag, or the +/−/Reset controls),
// synced through `setData` like the rest of the view state.
//
// All view state (perspective, expansion, selection, sequence step, pan/zoom) round-trips
// through `setData`, so the card is a shared surface: what one viewer opens, steps to, or
// pans/zooms to, every collaborator sees, and it survives a reload.

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
  zoom: number;
  pan: { x: number; y: number };
};

export default function IlographDiagram(props: {
  resources?: Resource[];
  perspectives?: Perspective[];
  accent?: string;
  perspective?: string;
  expanded?: Record<string, boolean>;
  selected?: string | null;
  step?: number;
  zoom?: number;
  pan?: { x: number; y: number };
  setData?: (patch: Record<string, unknown>) => void;
  [k: string]: unknown;
}) {
  const { setData, accent = '#4a9eff' } = props;
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
    zoom: props.zoom ?? 1,
    pan: props.pan ?? { x: 0, y: 0 },
  };
  const view: View = setData ? fromProps : { ...fromProps, ...local };
  const commit = (patch: Partial<View>) => (setData ? setData(patch) : setLocal((v) => ({ ...v, ...patch })));

  // Pan/zoom get an optimistic local overlay (`interim`) on top of the synced `view`, for
  // the same reason `local` exists above: without it, a drag or wheel tick would wait on a
  // setData round-trip before the drawing visibly moves.
  const svgRef = useRef<SVGSVGElement>(null);
  const [interim, setInterim] = useState<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  const pendingRef = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; startLocal: { x: number; y: number }; startPan: { x: number; y: number } } | null>(null);
  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  const zoom = interim?.zoom ?? view.zoom;
  const pan = interim?.pan ?? view.pan;

  const updateView = (patch: { zoom: number; pan: { x: number; y: number } }, immediate = false) => {
    setInterim(patch);
    pendingRef.current = patch;
    if (commitTimer.current) clearTimeout(commitTimer.current);
    if (immediate) {
      commit(patch);
      pendingRef.current = null;
      commitTimer.current = null;
      return;
    }
    commitTimer.current = setTimeout(() => {
      if (pendingRef.current) commit(pendingRef.current);
      pendingRef.current = null;
      commitTimer.current = null;
    }, 400);
  };
  const flushPending = () => {
    if (commitTimer.current) { clearTimeout(commitTimer.current); commitTimer.current = null; }
    if (pendingRef.current) { commit(pendingRef.current); pendingRef.current = null; }
  };

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

  const zoomAt = (factor: number, clientX: number, clientY: number, immediate = false) => {
    const newZoom = Math.max(0.25, Math.min(4, zoom * factor));
    if (newZoom === zoom) return;
    const p = toLocal(clientX, clientY);
    const newPan = {
      x: p.x - (newZoom / zoom) * (p.x - pan.x),
      y: p.y - (newZoom / zoom) * (p.y - pan.y),
    };
    updateView({ zoom: newZoom, pan: newPan }, immediate);
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;

  // Wheel needs a non-passive native listener — React's onWheel is passive by default, so
  // preventDefault() there is a no-op and the page/canvas would scroll instead of zooming.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtRef.current(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const current = perspectives.find((p) => p.id === view.perspective) ?? perspectives[0];
  const { byId, parentOf } = indexModel(resources);
  const nodes = visibleNodes(resources, view.expanded);
  const edges = resolveRelations(current.relations, nodes, byId, parentOf);
  // Pruned against the perspective's WHOLE edge set, not the sequence's `drawn` prefix:
  // stepping is a walk through one path, and a node the path has not reached yet is dimmed
  // below, not absent. Dropping it per step would make the layout jump on every press.
  const shown = connectedNodes(nodes, edges);
  const { pos, width, height } = layerNodes(shown, edges);

  const isSeq = !!current.sequence;
  const step = Math.max(0, Math.min(view.step, edges.length));
  // Step 0 idles the whole flow at low intensity; stepping lights it up in order.
  const idle = isSeq && step === 0;
  const cursor = isSeq && !idle ? step - 1 : -1;
  const drawn = isSeq && !idle ? edges.slice(0, step) : edges;
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

  const onNode = (id: string) => {
    const patch: Partial<View> = { selected: view.selected === id ? null : id };
    if (byId[id]?.children?.length) patch.expanded = { ...view.expanded, [id]: !view.expanded[id] };
    setPlaying(false);
    commit(patch);
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
        faded: !!view.selected && e.from !== view.selected && e.to !== view.selected,
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
          <Btn onClick={() => {
            const r = svgRef.current?.getBoundingClientRect();
            zoomAt(1 / 1.2, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0, true);
          }}>−</Btn>
          <span style={{ color: C.dim, fontSize: 11, minWidth: 32, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <Btn onClick={() => {
            const r = svgRef.current?.getBoundingClientRect();
            zoomAt(1.2, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0, true);
          }}>+</Btn>
          <Btn onClick={() => updateView({ zoom: 1, pan: { x: 0, y: 0 } }, true)}>Reset</Btn>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <svg ref={svgRef} viewBox={`0 0 ${width + PAD * 2} ${height + PAD * 2 + 34}`} preserveAspectRatio="xMidYMid meet"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' }}
          onPointerDown={(e) => {
            if ((e.target as Element).closest('[data-node]')) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { pointerId: e.pointerId, startLocal: toLocal(e.clientX, e.clientY), startPan: pan };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            const cur = toLocal(e.clientX, e.clientY);
            updateView({ zoom, pan: { x: d.startPan.x + (cur.x - d.startLocal.x), y: d.startPan.y + (cur.y - d.startLocal.y) } });
          }}
          onPointerUp={(e) => {
            if (dragRef.current?.pointerId !== e.pointerId) return;
            dragRef.current = null;
            flushPending();
          }}
          onPointerCancel={(e) => {
            if (dragRef.current?.pointerId !== e.pointerId) return;
            dragRef.current = null;
            flushPending();
          }}>
          <defs>
            <filter id="ilo-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          <g transform={`translate(${PAD},${PAD})`}>
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
              const hot = isSeq && !idle ? lit.has(n.id) : true;
              const sel = view.selected === n.id;
              return (
                // role="button" is what lets the click through the shape's capture-phase
                // guard (src/predicates.ts) — a bare <g onClick> would silently never fire.
                <g key={n.id} role="button" tabIndex={0} data-node={n.id} onClick={() => onNode(n.id)}
                  style={{ cursor: 'pointer' }} opacity={hot ? 1 : 0.3}>
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
