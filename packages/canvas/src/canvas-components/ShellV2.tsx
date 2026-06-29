import { useState } from 'react';

// Exploration of the VARIANT 2 styling (dark icon rail + light section list), with a
// HEADERLESS canvas — the canvas surface is pure infinite canvas, no top toolbar.
// Props: { sub?: 'a' | 'e' | 'f' | 'g', accent?: string, label?: string }
// 'a' is the original; e/f/g are restylings that keep the same dark-rail + light-list DNA.

interface Props {
  sub?: 'a' | 'e' | 'f' | 'g';
  accent?: string;
  label?: string;
}

const PAGES = [
  { name: 'Cloner POC', emoji: '🧬', count: 12, active: true },
  { name: 'Landing variants', emoji: '🎨', count: 8 },
  { name: 'Avatar pipeline', emoji: '🤖', count: 5 },
  { name: 'Fredrin', emoji: '📋', count: 6 },
  { name: 'Scratch', emoji: '✏️', count: 3 },
];

const RAIL = [
  { icon: '📄', name: 'Pages', active: true },
  { icon: '💬', name: 'Chats' },
  { icon: '🧩', name: 'Components' },
  { icon: '🔍', name: 'Search' },
];

// ---- Pure canvas surface: dotted grid + a couple mock shapes, NO header/toolbar ----
function Canvas() {
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden',
      background: 'radial-gradient(circle, #e2e8f0 1px, transparent 1px)',
      backgroundSize: '18px 18px', backgroundColor: '#fafafa' }}>
      <div style={{ position: 'absolute', top: 30, left: 30, width: 124, height: 80,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: 10, fontSize: 10, color: '#64748b' }}>
        <div style={{ fontWeight: 700, color: '#334155', marginBottom: 5 }}>Chat 1</div>
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, marginBottom: 4 }} />
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, width: '70%' }} />
      </div>
      <div style={{ position: 'absolute', top: 116, left: 196, width: 96, height: 96,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', display: 'grid', placeItems: 'center', fontSize: 22 }}>📊</div>
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <line x1="154" y1="110" x2="196" y2="158" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="4 3" />
      </svg>
    </div>
  );
}

// ---- Shared dark icon rail (the constant across A / E / F / G) ----
function DarkRail({ accent }: { accent: string }) {
  return (
    <div style={{ width: 52, flexShrink: 0, background: '#0f172a', display: 'flex',
      flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 4 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: accent,
        display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 14, marginBottom: 10 }}>Z</div>
      {RAIL.map((r) => (
        <div key={r.name} title={r.name} style={{ width: 38, height: 38, borderRadius: 9,
          display: 'grid', placeItems: 'center', fontSize: 16, cursor: 'pointer',
          background: r.active ? 'rgba(255,255,255,0.12)' : 'transparent',
          borderLeft: r.active ? `2px solid ${accent}` : '2px solid transparent' }}>{r.icon}</div>
      ))}
      <div style={{ marginTop: 'auto', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center', fontSize: 15, color: '#94a3b8' }}>⚙</div>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#334155',
          color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700 }}>J</div>
      </div>
    </div>
  );
}

// =================================================================
// A — Dark rail + light list (the original v2, headerless canvas)
// =================================================================
function SubA({ accent }: { accent: string }) {
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <DarkRail accent={accent} />
      <div style={{ width: 152, flexShrink: 0, background: '#f8fafc', borderRight: '1px solid #eef2f7',
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 14px 8px', fontSize: 13, fontWeight: 700, color: '#1e293b',
          display: 'flex', alignItems: 'center' }}>
          Pages <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 15, cursor: 'pointer' }}>＋</span>
        </div>
        <div style={{ padding: '2px 8px', flex: 1, overflow: 'auto' }}>
          {PAGES.map((p) => (
            <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px',
              fontSize: 12, borderRadius: 7, cursor: 'pointer',
              background: p.active ? '#fff' : 'transparent',
              boxShadow: p.active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              color: p.active ? '#1e293b' : '#64748b', fontWeight: p.active ? 600 : 500 }}>
              <span>{p.emoji}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>
      <Canvas />
    </div>
  );
}

// =================================================================
// E — Accent-selected rows + inline search at top of the list
// =================================================================
function SubE({ accent }: { accent: string }) {
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <DarkRail accent={accent} />
      <div style={{ width: 172, flexShrink: 0, background: '#f8fafc', borderRight: '1px solid #eef2f7',
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 12px 6px', fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Pages</div>
        <div style={{ padding: '0 10px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff',
            border: '1px solid #e7ecf3', borderRadius: 8, padding: '6px 9px', fontSize: 11.5, color: '#94a3b8' }}>
            <span>🔍</span><span>Search pages</span>
          </div>
        </div>
        <div style={{ padding: '2px 8px', flex: 1, overflow: 'auto' }}>
          {PAGES.map((p) => (
            <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px',
              fontSize: 12, borderRadius: 8, cursor: 'pointer', marginBottom: 2,
              background: p.active ? accent + '14' : 'transparent',
              borderLeft: p.active ? `2.5px solid ${accent}` : '2.5px solid transparent',
              color: p.active ? '#0f172a' : '#64748b', fontWeight: p.active ? 600 : 500 }}>
              <span>{p.emoji}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>
      <Canvas />
    </div>
  );
}

// =================================================================
// F — Dense list grouped into sections (Pinned / Recent) with counts
// =================================================================
function SubF({ accent }: { accent: string }) {
  const groups = [
    { label: 'Pinned', items: PAGES.slice(0, 2) },
    { label: 'Recent', items: PAGES.slice(2) },
  ];
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <DarkRail accent={accent} />
      <div style={{ width: 158, flexShrink: 0, background: '#f8fafc', borderRight: '1px solid #eef2f7',
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '13px 12px 6px', fontSize: 13, fontWeight: 700, color: '#1e293b',
          display: 'flex', alignItems: 'center' }}>
          Pages <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 15, cursor: 'pointer' }}>＋</span>
        </div>
        <div style={{ padding: '2px 8px', flex: 1, overflow: 'auto' }}>
          {groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
                color: '#b6c2d2', padding: '6px 6px 3px' }}>{g.label}</div>
              {g.items.map((p) => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 7px',
                  fontSize: 11.5, borderRadius: 6, cursor: 'pointer',
                  background: p.active ? '#fff' : 'transparent',
                  boxShadow: p.active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                  color: p.active ? '#1e293b' : '#64748b', fontWeight: p.active ? 600 : 500 }}>
                  <span style={{ fontSize: 12 }}>{p.emoji}</span>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9.5, color: '#cbd5e1' }}>{p.count}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <Canvas />
    </div>
  );
}

// =================================================================
// G — Carded list items + workspace switcher header (white list panel)
// =================================================================
function SubG({ accent }: { accent: string }) {
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <DarkRail accent={accent} />
      <div style={{ width: 180, flexShrink: 0, background: '#fff', borderRight: '1px solid #eef2f7',
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 12px 10px', display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: accent + '22',
            display: 'grid', placeItems: 'center', fontSize: 12 }}>🗂️</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1e293b' }}>Workspace</div>
          <span style={{ marginLeft: 'auto', color: '#cbd5e1', fontSize: 11 }}>⌄</span>
        </div>
        <div style={{ padding: 8, flex: 1, overflow: 'auto' }}>
          {PAGES.map((p) => (
            <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 9px',
              marginBottom: 5, borderRadius: 9, cursor: 'pointer', background: '#fff',
              border: p.active ? `1.5px solid ${accent}` : '1px solid #eef2f7',
              boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, background: '#f1f5f9',
                display: 'grid', placeItems: 'center', fontSize: 13 }}>{p.emoji}</div>
              <span style={{ fontSize: 11.5, fontWeight: p.active ? 600 : 500,
                color: p.active ? '#0f172a' : '#475569',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>
      <Canvas />
    </div>
  );
}

export default function ShellV2({ sub = 'a', accent = '#0ea5e9', label = '' }: Props) {
  const [s] = useState(sub);
  const body = s === 'e' ? <SubE accent={accent} />
    : s === 'f' ? <SubF accent={accent} />
    : s === 'g' ? <SubG accent={accent} />
    : <SubA accent={accent} />;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui',
      overflow: 'hidden', border: '1px solid #e2e8f0', borderRadius: 14, background: '#fff',
      boxShadow: '0 4px 18px rgba(15,23,42,0.08)' }}>
      {label && (
        <div style={{ flexShrink: 0, padding: '8px 14px', background: '#0f172a', color: '#fff',
          fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3,
          display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
          {label}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>{body}</div>
    </div>
  );
}
