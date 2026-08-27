// LOCAL DEV ONLY — a component bench with no canvas around it.
//
// `?preview=<Module>` already renders one module inside the pad, but a preview has no
// `data`, and the components worth iterating on are exactly the ones driven by it. This
// entry supplies `data` from a fixture and wires `setData` the way `ComponentHost` does
// (shallow patch merge), so a card's own controls — perspective tabs, expand, step — work
// here as they do on a board.
//
// It never ships: the production build runs from `shell/vite.config.ts`, which does not
// know this file. Reached at http://localhost:$PORT/dev/playground.html.
//
// Components are pulled in with `import.meta.glob`, deliberately: a static import would
// drag `src/canvas-components` into the project typecheck, and tsconfig excludes that
// directory on purpose (agent-authored at runtime, no type gate). Dynamic keeps this file
// checked and them not.

import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { FIXTURES } from './fixtures.ts';

type Loaded = (props: Record<string, unknown>) => React.ReactNode;

const MODULES = import.meta.glob('../src/canvas-components/*.tsx');
const nameOf = (path: string) => path.split('/').pop()!.replace(/\.tsx$/, '');
const NAMES = Object.keys(MODULES).map(nameOf).sort();

const C = {
  bg: '#0c0e14',
  panel: '#101520',
  line: '#232936',
  text: '#e6ebf5',
  muted: '#7a8090',
  accent: '#4a9eff',
};

/** URL is the address of a bench setup, so a reload keeps it and a link shares it. */
function useQuery() {
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search));
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    window.history.replaceState(null, '', `?${next}`);
    setQ(next);
  };
  return [q, set] as const;
}

function Bench() {
  const [q, setQ] = useQuery();
  const module = q.get('m') && NAMES.includes(q.get('m')!) ? q.get('m')! : (NAMES[0] ?? '');
  const fixtures = FIXTURES[module] ?? {};
  const fixtureNames = ['none', ...Object.keys(fixtures)];
  const fixture = fixtureNames.includes(q.get('f') ?? '') ? q.get('f')! : (fixtureNames[1] ?? 'none');

  const seed = useMemo(
    () => (fixture === 'none' ? {} : { ...(fixtures[fixture] ?? {}) }),
    [module, fixture],
  );
  const [data, setData] = useState<Record<string, unknown>>(seed);
  useEffect(() => setData(seed), [seed]);

  const [Comp, setComp] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setComp(null);
    setError(null);
    const load = MODULES[`../src/canvas-components/${module}.tsx`];
    if (!load) return;
    void load()
      .then((m) => alive && setComp(() => (m as { default: Loaded }).default))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [module]);

  // ComponentHost's contract: a patch MERGES into data, it does not replace it.
  const patch = (p: Record<string, unknown>) => setData((d) => ({ ...d, ...p }));

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: C.bg, color: C.text,
      font: '13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
        <strong style={{ color: C.accent }}>playground</strong>
        <Select value={module} options={NAMES} onChange={(v) => setQ({ m: v, f: 'none' })} />
        <Select value={fixture} options={fixtureNames} onChange={(v) => setQ({ f: v })} />
        <button type="button" onClick={() => setData(seed)}
          style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.text, borderRadius: 7, padding: '4px 12px', font: 'inherit', cursor: 'pointer' }}>
          Reset data
        </button>
        <span style={{ color: C.muted, marginLeft: 'auto' }}>local dev only · not in the production build</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* resize: the shape is user-sized on a board, and layout bugs live at odd sizes */}
        <div style={{ flex: 1, minWidth: 0, padding: 20, overflow: 'auto' }}>
          <div style={{ width: 1000, height: 720, maxWidth: '100%', resize: 'both', overflow: 'hidden',
            border: `1px solid ${C.line}`, borderRadius: 10 }}>
            {error ? <pre style={{ padding: 16, color: '#ff8a8a' }}>{error}</pre>
              : Comp ? <Comp {...data} setData={patch} />
              : <div style={{ padding: 16, color: C.muted }}>loading {module}…</div>}
          </div>
        </div>

        <div style={{ width: 340, flexShrink: 0, borderLeft: `1px solid ${C.line}`, padding: 14, overflow: 'auto', background: C.panel }}>
          <div style={{ color: C.muted, marginBottom: 8 }}>data (what setData has written)</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, color: C.text }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.text, borderRadius: 7, padding: '4px 8px', font: 'inherit' }}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Bench /></StrictMode>);
