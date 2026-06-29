import { useState } from 'react';

// Mockup of the agent-canvas APP SHELL: a fixed left navigation panel + the canvas area.
// This is a STATIC MOCK for design exploration — nothing here is wired to the real app.
// Props: { variant?: 1 | 2 | 3, label?: string, accent?: string }
// Three variations of the left shell nav, each shown beside a mock canvas surface.

interface Props {
  variant?: 1 | 2 | 3;
  label?: string;
  accent?: string;
}

const PAGES = [
  { name: 'Cloner POC', emoji: '🧬', count: 12, active: true },
  { name: 'Landing variants', emoji: '🎨', count: 8 },
  { name: 'Avatar pipeline', emoji: '🤖', count: 5 },
  { name: 'Fredrin', emoji: '📋', count: 6 },
  { name: 'Scratch', emoji: '✏️', count: 3 },
];

// ---- shared: the mock canvas surface to the right of the nav ----
function CanvasSurface({ title }: { title: string }) {
  return (
    <div style={{ flex: 1, position: 'relative', background:
      'radial-gradient(circle, #e2e8f0 1px, transparent 1px)',
      backgroundSize: '18px 18px', backgroundColor: '#fafafa', overflow: 'hidden' }}>
      {/* top toolbar of the canvas */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 38,
        background: 'rgba(255,255,255,0.8)', backdropFilter: 'blur(4px)',
        borderBottom: '1px solid #eef2f7', display: 'flex', alignItems: 'center',
        padding: '0 14px', gap: 10, fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>
        <span style={{ color: '#334155', fontWeight: 700 }}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: '#f1f5f9', display: 'grid', placeItems: 'center' }}>＋</span>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: '#f1f5f9', display: 'grid', placeItems: 'center' }}>⤢</span>
        </span>
      </div>
      {/* mock shapes on the canvas */}
      <div style={{ position: 'absolute', top: 64, left: 26, width: 120, height: 78,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: 10, fontSize: 10, color: '#64748b' }}>
        <div style={{ fontWeight: 700, color: '#334155', marginBottom: 4 }}>Chat 1</div>
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, marginBottom: 4 }} />
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, width: '70%' }} />
      </div>
      <div style={{ position: 'absolute', top: 108, left: 188, width: 96, height: 96,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', display: 'grid', placeItems: 'center',
        fontSize: 22 }}>📊</div>
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <line x1="146" y1="103" x2="188" y2="150" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="4 3" />
      </svg>
    </div>
  );
}

// =================================================================
// VARIANT 1 — Classic full sidebar (Notion / Linear style)
// =================================================================
function Variant1({ accent }: { accent: string }) {
  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: 'system-ui', background: '#fff' }}>
      <aside style={{ width: 188, flexShrink: 0, background: '#fbfbfc',
        borderRight: '1px solid #eef2f7', display: 'flex', flexDirection: 'column' }}>
        {/* workspace header */}
        <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: accent,
            display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 13 }}>Z</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Zabaca</div>
          <span style={{ marginLeft: 'auto', color: '#cbd5e1', fontSize: 11 }}>⌄</span>
        </div>
        {/* quick actions */}
        <div style={{ padding: '0 8px 8px' }}>
          {['🔍 Search', '⊕ New page'].map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              fontSize: 12, color: '#64748b', borderRadius: 7, cursor: 'pointer', fontWeight: 500 }}>{t}</div>
          ))}
        </div>
        {/* pages list */}
        <div style={{ padding: '6px 8px', flex: 1, overflow: 'auto' }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
            color: '#b6c2d2', padding: '6px 8px 4px' }}>Pages</div>
          {PAGES.map((p) => (
            <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              fontSize: 12.5, borderRadius: 7, cursor: 'pointer',
              background: p.active ? '#eef2ff' : 'transparent',
              color: p.active ? '#1e293b' : '#475569', fontWeight: p.active ? 600 : 500 }}>
              <span style={{ fontSize: 13 }}>{p.emoji}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#cbd5e1' }}>{p.count}</span>
            </div>
          ))}
        </div>
        {/* account footer */}
        <div style={{ borderTop: '1px solid #eef2f7', padding: '10px 12px', display: 'flex',
          alignItems: 'center', gap: 9 }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#1e293b',
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700 }}>J</div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#334155' }}>James</div>
          <span style={{ marginLeft: 'auto', color: '#cbd5e1' }}>⚙</span>
        </div>
      </aside>
      <CanvasSurface title="Cloner POC" />
    </div>
  );
}

// =================================================================
// VARIANT 2 — Icon rail + flyout list (IDE / VS Code style)
// =================================================================
function Variant2({ accent }: { accent: string }) {
  const rail = [
    { icon: '📄', name: 'Pages', active: true },
    { icon: '💬', name: 'Chats' },
    { icon: '🧩', name: 'Components' },
    { icon: '🔍', name: 'Search' },
  ];
  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: 'system-ui', background: '#fff' }}>
      {/* slim icon rail */}
      <div style={{ width: 52, flexShrink: 0, background: '#0f172a', display: 'flex',
        flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 4 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: accent,
          display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 14, marginBottom: 10 }}>Z</div>
        {rail.map((r) => (
          <div key={r.name} title={r.name} style={{ width: 38, height: 38, borderRadius: 9,
            display: 'grid', placeItems: 'center', fontSize: 16, cursor: 'pointer',
            background: r.active ? 'rgba(255,255,255,0.12)' : 'transparent',
            borderLeft: r.active ? `2px solid ${accent}` : '2px solid transparent' }}>{r.icon}</div>
        ))}
        <div style={{ marginTop: 'auto', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center', fontSize: 15, color: '#94a3b8' }}>⚙</div>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#334155',
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, margin: '0 auto' }}>J</div>
        </div>
      </div>
      {/* secondary panel: active section list */}
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
      <CanvasSurface title="Cloner POC" />
    </div>
  );
}

// =================================================================
// VARIANT 3 — Visual page cards with grouped sections
// =================================================================
function Variant3({ accent }: { accent: string }) {
  const groups = [
    { label: 'Pinned', items: PAGES.slice(0, 2) },
    { label: 'Recent', items: PAGES.slice(2) },
  ];
  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: 'system-ui', background: '#fff' }}>
      <aside style={{ width: 208, flexShrink: 0,
        background: 'linear-gradient(180deg,#fafbff 0%,#f4f6fb 100%)',
        borderRight: '1px solid #eef2f7', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '15px 16px 12px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: accent,
            display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 14 }}>Z</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', lineHeight: 1.1 }}>Workspace</div>
            <div style={{ fontSize: 10, color: '#94a3b8' }}>5 pages</div>
          </div>
        </div>
        <div style={{ padding: '0 12px 10px' }}>
          <button style={{ width: '100%', border: 'none', background: accent, color: '#fff',
            padding: '9px 0', borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            ＋ New page
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 12px 12px' }}>
          {groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
                color: '#b6c2d2', padding: '4px 2px 6px' }}>{g.label}</div>
              {g.items.map((p) => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  marginBottom: 5, borderRadius: 10, cursor: 'pointer', background: '#fff',
                  border: p.active ? `1.5px solid ${accent}` : '1px solid #eef2f7',
                  boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: '#f1f5f9',
                    display: 'grid', placeItems: 'center', fontSize: 15 }}>{p.emoji}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{p.count} items</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid #eef2f7', padding: '10px 14px', display: 'flex',
          alignItems: 'center', gap: 9 }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#1e293b',
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700 }}>J</div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#334155' }}>James</div>
        </div>
      </aside>
      <CanvasSurface title="Cloner POC" />
    </div>
  );
}

export default function ShellMock({ variant = 1, label = '', accent = '#6366f1' }: Props) {
  const [v] = useState(variant);
  const body = v === 2 ? <Variant2 accent={accent} /> : v === 3 ? <Variant3 accent={accent} /> : <Variant1 accent={accent} />;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid #e2e8f0', borderRadius: 14, overflow: 'hidden',
      boxShadow: '0 4px 18px rgba(15,23,42,0.08)', background: '#fff' }}>
      {label && (
        <div style={{ flexShrink: 0, padding: '8px 14px', background: '#0f172a', color: '#fff',
          fontFamily: 'system-ui', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3,
          display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
          {label}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>{body}</div>
    </div>
  );
}
