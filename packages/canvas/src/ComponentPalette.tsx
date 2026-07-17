// Built-in component palette: browse the canvas's component library (own dir + workspace
// shared + platform base, via GET /api/components) and place instances with one click
// (POST /api/components/place — the same pair the agent's list/place tools use). Lives in
// the pad chrome (a toggleable panel), not on the canvas: no per-canvas copy, no canvas
// real estate, no custom-handler proxy. Members only — placement is a write.

import * as React from 'react';

import { withCanvasHeader } from './active-canvas';

const CELL_W = 360;
const CELL_H = 260;

/** Where the next instance lands: the viewport's center, cascaded a step per add so
 *  repeated placements don't stack exactly. */
export function placementAt(center: { x: number; y: number }, placed: number): { x: number; y: number; w: number; h: number } {
  const step = (placed % 5) * 28;
  return { x: center.x - CELL_W / 2 + step, y: center.y - CELL_H / 2 + step, w: CELL_W, h: CELL_H };
}

/** Case-insensitive substring filter over module names; a blank query keeps everything. */
export function filterModules(modules: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? modules.filter((m) => m.toLowerCase().includes(q)) : modules;
}

export function ComponentPalette({ viewportCenter, onClose }: { viewportCenter: () => { x: number; y: number }; onClose: () => void }) {
  const [modules, setModules] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [placing, setPlacing] = React.useState<string | null>(null);
  const placedRef = React.useRef(0);

  const load = React.useCallback(() => {
    setError(null);
    fetch('/api/components', { headers: withCanvasHeader() })
      .then(async (r) => {
        if (!r.ok) throw new Error(`list failed (${r.status})`);
        const { components } = (await r.json()) as { components: string[] };
        setModules(components);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  React.useEffect(load, [load]);

  const filtered = filterModules(modules ?? [], query);

  const place = async (module: string) => {
    setPlacing(module);
    setError(null);
    try {
      const r = await fetch('/api/components/place', {
        method: 'POST',
        headers: withCanvasHeader({ 'content-type': 'application/json' }),
        body: JSON.stringify({ module, ...placementAt(viewportCenter(), placedRef.current) }),
      });
      if (!r.ok) throw new Error(`place failed (${r.status})`);
      placedRef.current += 1;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlacing(null);
    }
  };

  return (
    <div className="component-palette">
      <div className="component-palette-head">
        <span className="component-palette-title">Components</span>
        <span className="component-palette-count">{modules ? filtered.length : '…'}</span>
        <button type="button" className="component-palette-refresh" title="Refresh the list" onClick={load}>
          ↻
        </button>
        <button type="button" className="component-palette-close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <input
        className="component-palette-filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter components…"
      />
      {error && <div className="component-palette-error">{error}</div>}
      <div className="component-palette-list">
        {modules !== null && filtered.length === 0 && <div className="component-palette-empty">No matches.</div>}
        {filtered.map((m) => (
          <div key={m} className="component-palette-row">
            <span className="component-palette-name" title={m}>
              {m}
            </span>
            <button type="button" className="component-palette-add" disabled={placing === m} onClick={() => void place(m)}>
              {placing === m ? 'Adding…' : '+ Add'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
