// A live browser over this canvas's component library, placeable on the canvas itself.
// Lists every module (own + shared + platform tier, via GET /api/components), lets you
// search/filter, and click "+ Add" to drop a fresh instance onto the canvas (POST
// /api/components/place) — no agent round-trip needed. Placements cascade in a grid to the
// right of wherever this catalog sits.
//
// REPOINTED DURING RESTORATION (#365). As recovered, both calls went to
// /api/custom/component-catalog — a custom handler destroyed in the same 2026-07-29 flush
// that took this component, and a feature since removed (#357). It was a thin proxy, so this
// calls its two targets directly: the listing is now edge-served and canvas-scoped by the
// x-canvas-id header this component already sent (#363), and placement is the bridge route
// the platform gallery uses. Nothing else about the recovered source changed.
//
// The x-canvas-id header is derived from window.location.pathname (mirrors src/active-canvas.ts's
// canvasIdFromPath) since this component isn't handed a canvasId prop directly.
import { useEffect, useMemo, useState } from 'react';

type Data = {
  title?: string;
  anchorX?: number;
  anchorY?: number;
  placedCount?: number;
};

type SetData = (patch: Partial<Data>) => void;

const GRID_COLS = 3;
const CELL_W = 380;
const CELL_H = 280;
const GUTTER = 24;

function activeCanvasId(): string {
  if (typeof window === 'undefined') return 'default';
  const m = /^\/w\/[^/]+\/canvas\/([^/]+)\/pad\/?$/.exec(window.location.pathname);
  return m?.[1] ?? 'default';
}

async function api(path: string, method: 'GET' | 'POST', body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-canvas-id': activeCanvasId() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `request failed (${res.status})`);
  return json;
}

export default function ComponentCatalog({
  title = 'Components',
  anchorX = 40,
  anchorY = 40,
  placedCount = 0,
  setData,
}: Data & { setData?: SetData }) {
  const [modules, setModules] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [placing, setPlacing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api('/api/components', 'GET')
      .then((json) => setModules(Array.isArray(json.components) ? (json.components as string[]) : []))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = modules ?? [];
    return q ? list.filter((m) => m.toLowerCase().includes(q)) : list;
  }, [modules, query]);

  const place = async (module: string) => {
    setPlacing(module);
    setError(null);
    const col = placedCount % GRID_COLS;
    const row = Math.floor(placedCount / GRID_COLS);
    const x = anchorX + (col + 1) * (CELL_W + GUTTER);
    const y = anchorY + row * (CELL_H + GUTTER);
    try {
      await api('/api/components/place', 'POST', { module, x, y, w: CELL_W, h: CELL_H });
      setData?.({ placedCount: placedCount + 1 });
      setToast(`Added ${module}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlacing(null);
    }
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        font: '13px ui-sans-serif, system-ui',
        color: '#0f172a',
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{modules ? `${filtered.length}/${modules.length}` : '…'}</span>
        <button
          type="button"
          onClick={load}
          title="Refresh"
          style={{ marginLeft: 'auto', border: '1px solid #e2e8f0', background: '#fff', borderRadius: 6, width: 26, height: 24, cursor: 'pointer', color: '#475569' }}
        >
          ↻
        </button>
      </div>

      <div style={{ padding: '10px 12px 0' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter components…"
          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 10px', font: 'inherit' }}
        />
      </div>

      {error && <div style={{ margin: '8px 12px 0', color: '#dc2626', fontSize: 12 }}>{error}</div>}

      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {modules === null && !error && <div style={{ color: '#94a3b8', padding: '4px 4px' }}>Loading…</div>}
        {modules !== null && filtered.length === 0 && <div style={{ color: '#94a3b8', padding: '4px 4px' }}>No matches.</div>}
        {filtered.map((m) => (
          <div
            key={m}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid #e2e8f0',
              background: '#fff',
              borderRadius: 8,
              padding: '7px 9px',
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m}>
              {m}
            </span>
            <button
              type="button"
              disabled={placing === m}
              onClick={() => place(m)}
              style={{
                border: '1px solid #93c5fd',
                background: placing === m ? '#eff6ff' : '#dbeafe',
                color: '#1d4ed8',
                borderRadius: 6,
                padding: '4px 10px',
                cursor: placing === m ? 'default' : 'pointer',
                fontWeight: 600,
                fontSize: 12,
                whiteSpace: 'nowrap',
              }}
            >
              {placing === m ? 'Adding…' : '+ Add'}
            </button>
          </div>
        ))}
      </div>

      {toast && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12, background: '#0f172a', color: '#fff', borderRadius: 8, padding: '7px 10px', fontSize: 12, textAlign: 'center' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
