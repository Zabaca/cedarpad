// Collapsible JSON viewer card: renders any pasted/agent-supplied JSON as a lazy
// tree — collapsed subtrees aren't in the DOM, big arrays load in chunks — so even
// huge documents stay cheap. Props: { title?, value: any JSON }.
import * as React from 'react';

const CHUNK = 100;
const OPEN_DEPTH = 2; // depth < OPEN_DEPTH starts expanded

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const color = (v: unknown) =>
  v === null ? 'var(--muted, #64748b)' : typeof v === 'string' ? '#16a34a' : typeof v === 'number' ? '#2563eb' : typeof v === 'boolean' ? '#9333ea' : 'inherit';

function Primitive({ v }: { v: unknown }) {
  const text = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return <span style={{ color: color(v) }}>{text.length > 300 ? `${text.slice(0, 300)}…` : text}</span>;
}

function Node({ k, v, depth }: { k: string | null; v: unknown; depth: number }) {
  const [open, setOpen] = React.useState(depth < OPEN_DEPTH);
  const [limit, setLimit] = React.useState(CHUNK);
  const branch = typeof v === 'object' && v !== null;
  const label = k !== null && <span style={{ color: 'var(--ink, #0f172a)', fontWeight: 500 }}>{k}: </span>;

  if (!branch) {
    return (
      <div data-json-entry style={{ paddingLeft: depth * 14 }}>
        {label}
        <Primitive v={v} />
      </div>
    );
  }

  const entries = Array.isArray(v) ? v.map((item, i) => [String(i), item] as const) : Object.entries(v as Record<string, unknown>);
  const preview = Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div data-json-entry style={{ paddingLeft: depth * 14 }}>
      <button
        type="button"
        data-toggle
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--muted, #64748b)' }}
      >
        {open ? '▾' : '▸'} {label}
        <span>{preview}</span>
      </button>
      {open && (
        <div>
          {entries.slice(0, limit).map(([ck, cv]) => (
            <Node key={ck} k={ck} v={cv} depth={depth + 1} />
          ))}
          {entries.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + 500)}
              style={{ marginLeft: (depth + 1) * 14, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--accent, #2563eb)' }}
            >
              … {(entries.length - limit).toLocaleString()} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function JsonCard({ title, value }: { title?: string; value?: unknown }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '8px 10px', font: `12px/1.6 ${MONO}`, color: 'var(--ink, #0f172a)' }}>
      {title && <div style={{ fontWeight: 700, fontSize: 13, fontFamily: 'ui-sans-serif, system-ui', marginBottom: 4 }}>{title}</div>}
      <Node k={null} v={value} depth={0} />
    </div>
  );
}
