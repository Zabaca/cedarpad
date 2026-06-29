import { useState } from 'react';

// CHOSEN DIRECTION (cleaned): three-tier nav — workspace > canvas > pages.
// Rail holds ONLY what exists today: the workspace switcher (Z) and Canvases.
// Settings gear + user avatar stay pinned at the bottom. Pages panel uses the
// breadcrumb header ("Canvases > Cloner POC"). Canvas stays headerless.
// Props: { accent?: string, label?: string, view?: 'canvases' | 'pages' }

interface Props { accent?: string; label?: string; view?: 'canvases' | 'pages' }

const CANVASES = [
  { name: 'Cloner POC', emoji: '🧬', count: 5, active: true },
  { name: 'Landing variants', emoji: '🎨', count: 8 },
  { name: 'Avatar pipeline', emoji: '🤖', count: 5 },
  { name: 'Fredrin', emoji: '📋', count: 6 },
  { name: 'Scratch', emoji: '✏️', count: 3 },
];
const PAGES = [
  { name: 'Overview', emoji: '📄', active: true },
  { name: 'Pipeline', emoji: '🔧' },
  { name: 'Avatar tests', emoji: '🧪' },
  { name: 'B-roll', emoji: '🎬' },
  { name: 'Notes', emoji: '🗒️' },
];

function Canvas() {
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden',
      background: 'radial-gradient(circle, #e2e8f0 1px, transparent 1px)',
      backgroundSize: '18px 18px', backgroundColor: '#fafafa' }}>
      <div style={{ position: 'absolute', top: 32, left: 34, width: 122, height: 80,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: 10, fontSize: 10, color: '#64748b' }}>
        <div style={{ fontWeight: 700, color: '#334155', marginBottom: 5 }}>Chat 1</div>
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, marginBottom: 4 }} />
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, width: '70%' }} />
      </div>
      <div style={{ position: 'absolute', top: 120, left: 200, width: 94, height: 94,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', display: 'grid', placeItems: 'center', fontSize: 22 }}>📊</div>
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <line x1="156" y1="112" x2="200" y2="160" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="4 3" />
      </svg>
    </div>
  );
}

// Trimmed rail: workspace switcher (Z) + Canvases only. Gear + user pinned bottom.
function Rail({ accent }: { accent: string }) {
  return (
    <div style={{ width: 52, flexShrink: 0, background: '#0f172a', display: 'flex',
      flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 6 }}>
      <div title="Switch workspace" style={{ width: 32, height: 32, borderRadius: 9, background: accent,
        display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 14,
        marginBottom: 8, cursor: 'pointer' }}>Z</div>
      <div title="Canvases" style={{ width: 38, height: 38, borderRadius: 9, display: 'grid',
        placeItems: 'center', fontSize: 17, cursor: 'pointer', background: 'rgba(255,255,255,0.12)',
        borderLeft: `2px solid ${accent}` }}>📓</div>
      {/* pinned bottom: settings + user */}
      <div style={{ marginTop: 'auto', marginBottom: 10, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 8 }}>
        <div title="Settings" style={{ width: 38, height: 38, borderRadius: 9, display: 'grid',
          placeItems: 'center', fontSize: 15, color: '#94a3b8', cursor: 'pointer' }}>⚙</div>
        <div title="James" style={{ width: 28, height: 28, borderRadius: '50%', background: '#334155',
          color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>J</div>
      </div>
    </div>
  );
}

export default function ShellV4({ accent = '#0ea5e9', label = '', view = 'pages' }: Props) {
  const [v] = useState(view);

  const panel = v === 'canvases' ? (
    <div style={{ width: 178, flexShrink: 0, background: '#f8fafc', borderRight: '1px solid #eef2f7',
      display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 14px 8px', fontSize: 13, fontWeight: 700, color: '#1e293b',
        display: 'flex', alignItems: 'center' }}>
        Canvases <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 15, cursor: 'pointer' }}>＋</span>
      </div>
      <div style={{ padding: '2px 8px', flex: 1, overflow: 'auto' }}>
        {CANVASES.map((c) => (
          <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px',
            fontSize: 12, borderRadius: 7, cursor: 'pointer', marginBottom: 1,
            background: c.active ? '#fff' : 'transparent',
            boxShadow: c.active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            borderLeft: c.active ? `2px solid ${accent}` : '2px solid transparent',
            color: c.active ? '#1e293b' : '#64748b', fontWeight: c.active ? 600 : 500 }}>
            <span>{c.emoji}</span>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
            <span style={{ marginLeft: 'auto', fontSize: 9.5, color: '#cbd5e1' }}>{c.count}</span>
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div style={{ width: 178, flexShrink: 0, background: '#f8fafc', borderRight: '1px solid #eef2f7',
      display: 'flex', flexDirection: 'column' }}>
      {/* breadcrumb header: workspace-canvas trail */}
      <div style={{ padding: '13px 14px 5px', fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>
        <span style={{ cursor: 'pointer' }}>Canvases</span>
        <span style={{ margin: '0 5px', color: '#cbd5e1' }}>›</span>
        <span style={{ color: '#334155' }}>Cloner POC</span>
      </div>
      <div style={{ padding: '3px 14px 8px', fontSize: 9.5, fontWeight: 700, letterSpacing: 1,
        textTransform: 'uppercase', color: '#b6c2d2' }}>Pages</div>
      <div style={{ padding: '0 8px', flex: 1, overflow: 'auto' }}>
        {PAGES.map((p) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
            fontSize: 12, borderRadius: 7, cursor: 'pointer', marginBottom: 1,
            background: p.active ? '#fff' : 'transparent',
            boxShadow: p.active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            borderLeft: p.active ? `2px solid ${accent}` : '2px solid transparent',
            color: p.active ? '#1e293b' : '#64748b', fontWeight: p.active ? 600 : 500 }}>
            <span>{p.emoji}</span>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui',
      overflow: 'hidden', border: '1px solid #e2e8f0', borderRadius: 14, background: '#fff',
      boxShadow: '0 4px 18px rgba(15,23,42,0.08)' }}>
      {label && (
        <div style={{ flexShrink: 0, padding: '8px 14px', background: '#0f172a', color: '#fff',
          fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
          {label}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Rail accent={accent} />
        {panel}
        <Canvas />
      </div>
    </div>
  );
}
