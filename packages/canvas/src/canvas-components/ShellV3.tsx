import { useState } from 'react';

// Three-tier nav model on the 2A shell (dark icon rail + light list, headerless canvas):
//   workspace  ->  canvas  ->  pages
//   - Click the Z (rail top)      => workspace switcher
//   - Click 📓 (rail)             => list of CANVASES
//   - Click a canvas              => that canvas's PAGES, heading "<canvas> · Pages"
// Prop `state` selects which step / styling to render.
// Props: { state?: 'workspace'|'canvases'|'pages'|'pages-breadcrumb'|'pages-miller', accent?, label? }

type State = 'workspace' | 'canvases' | 'pages' | 'pages-breadcrumb' | 'pages-miller';
interface Props { state?: State; accent?: string; label?: string }

const WORKSPACES = [
  { name: 'Zabaca', glyph: 'Z', active: true },
  { name: 'Personal', glyph: 'P' },
];
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

const RAIL = [
  { icon: '📓', name: 'Canvases', key: 'canvases' },
  { icon: '💬', name: 'Chats', key: 'chats' },
  { icon: '🧩', name: 'Components', key: 'components' },
  { icon: '🔍', name: 'Search', key: 'search' },
];

// ---- headerless canvas surface ----
function Canvas() {
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden',
      background: 'radial-gradient(circle, #e2e8f0 1px, transparent 1px)',
      backgroundSize: '18px 18px', backgroundColor: '#fafafa' }}>
      <div style={{ position: 'absolute', top: 30, left: 30, width: 120, height: 78,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', padding: 10, fontSize: 10, color: '#64748b' }}>
        <div style={{ fontWeight: 700, color: '#334155', marginBottom: 5 }}>Chat 1</div>
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, marginBottom: 4 }} />
        <div style={{ height: 6, background: '#f1f5f9', borderRadius: 3, width: '70%' }} />
      </div>
      <div style={{ position: 'absolute', top: 112, left: 188, width: 92, height: 92,
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)', display: 'grid', placeItems: 'center', fontSize: 22 }}>📊</div>
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <line x1="150" y1="108" x2="188" y2="152" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="4 3" />
      </svg>
    </div>
  );
}

// ---- dark icon rail; Z = workspace switcher ----
function DarkRail({ accent, zActive = false }: { accent: string; zActive?: boolean }) {
  return (
    <div style={{ width: 52, flexShrink: 0, background: '#0f172a', display: 'flex',
      flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 4 }}>
      <div title="Switch workspace" style={{ width: 32, height: 32, borderRadius: 9, background: accent,
        display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 14, marginBottom: 10,
        boxShadow: zActive ? `0 0 0 3px rgba(255,255,255,0.25)` : 'none', cursor: 'pointer' }}>Z</div>
      {RAIL.map((r) => (
        <div key={r.key} title={r.name} style={{ width: 38, height: 38, borderRadius: 9,
          display: 'grid', placeItems: 'center', fontSize: 16, cursor: 'pointer',
          background: r.key === 'canvases' && !zActive ? 'rgba(255,255,255,0.12)' : 'transparent',
          borderLeft: r.key === 'canvases' && !zActive ? `2px solid ${accent}` : '2px solid transparent' }}>{r.icon}</div>
      ))}
      <div style={{ marginTop: 'auto', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center', fontSize: 15, color: '#94a3b8' }}>⚙</div>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#334155',
          color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700 }}>J</div>
      </div>
    </div>
  );
}

const panelBase: React.CSSProperties = {
  width: 168, flexShrink: 0, background: '#f8fafc', borderRight: '1px solid #eef2f7',
  display: 'flex', flexDirection: 'column',
};

function PageRow({ p, accent }: { p: typeof PAGES[number]; accent: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
      fontSize: 12, borderRadius: 7, cursor: 'pointer', marginBottom: 1,
      background: p.active ? '#fff' : 'transparent',
      boxShadow: p.active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
      borderLeft: p.active ? `2px solid ${accent}` : '2px solid transparent',
      color: p.active ? '#1e293b' : '#64748b', fontWeight: p.active ? 600 : 500 }}>
      <span>{p.emoji}</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
    </div>
  );
}

// ---- workspace switcher dropdown (overlay) ----
function WorkspacePopover({ accent }: { accent: string }) {
  return (
    <div style={{ position: 'absolute', top: 8, left: 58, width: 178, zIndex: 5,
      background: '#fff', borderRadius: 12, border: '1px solid #e7ecf3',
      boxShadow: '0 12px 30px rgba(15,23,42,0.22)', padding: 7, fontSize: 12 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
        color: '#b6c2d2', padding: '4px 8px 6px' }}>Workspaces</div>
      {WORKSPACES.map((w) => (
        <div key={w.name} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px',
          borderRadius: 8, cursor: 'pointer', background: w.active ? '#f1f5f9' : 'transparent' }}>
          <div style={{ width: 24, height: 24, borderRadius: 7,
            background: w.active ? accent : '#cbd5e1', color: '#fff',
            display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 11 }}>{w.glyph}</div>
          <span style={{ fontWeight: w.active ? 600 : 500, color: '#1e293b' }}>{w.name}</span>
          {w.active && <span style={{ marginLeft: 'auto', color: accent, fontWeight: 800 }}>✓</span>}
        </div>
      ))}
      <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 5, paddingTop: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px',
          color: '#64748b', fontWeight: 500, cursor: 'pointer' }}>
          <span style={{ width: 24, textAlign: 'center' }}>＋</span> New workspace
        </div>
      </div>
    </div>
  );
}

export default function ShellV3({ state = 'pages', accent = '#0ea5e9', label = '' }: Props) {
  const [s] = useState(state);

  let panel: React.ReactNode = null;
  let extraColumn: React.ReactNode = null;
  let overlay: React.ReactNode = null;

  if (s === 'workspace') {
    overlay = <WorkspacePopover accent={accent} />;
    panel = (
      <div style={{ ...panelBase, opacity: 0.45 }}>
        <div style={{ padding: '14px 14px 8px', fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Canvases</div>
        <div style={{ padding: '2px 8px' }}>
          {CANVASES.slice(0, 4).map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px',
              fontSize: 12, color: '#64748b' }}><span>{c.emoji}</span>{c.name}</div>
          ))}
        </div>
      </div>
    );
  } else if (s === 'canvases') {
    panel = (
      <div style={panelBase}>
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
    );
  } else if (s === 'pages-breadcrumb') {
    panel = (
      <div style={panelBase}>
        <div style={{ padding: '12px 14px 4px', fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>
          <span style={{ cursor: 'pointer' }}>Canvases</span>
          <span style={{ margin: '0 5px', color: '#cbd5e1' }}>›</span>
          <span style={{ color: '#334155' }}>Cloner POC</span>
        </div>
        <div style={{ padding: '4px 14px 8px', fontSize: 9.5, fontWeight: 700, letterSpacing: 1,
          textTransform: 'uppercase', color: '#b6c2d2' }}>Pages</div>
        <div style={{ padding: '0 8px', flex: 1, overflow: 'auto' }}>
          {PAGES.map((p) => <PageRow key={p.name} p={p} accent={accent} />)}
        </div>
      </div>
    );
  } else if (s === 'pages-miller') {
    // rail + narrow canvas column + pages column
    extraColumn = (
      <div style={{ width: 116, flexShrink: 0, background: '#f1f5f9', borderRight: '1px solid #e7ecf3',
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '13px 12px 6px', fontSize: 11, fontWeight: 700, color: '#64748b' }}>Canvases</div>
        <div style={{ padding: '2px 6px' }}>
          {CANVASES.map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 7px',
              fontSize: 11, borderRadius: 6, cursor: 'pointer', marginBottom: 1,
              background: c.active ? '#fff' : 'transparent',
              color: c.active ? '#0f172a' : '#64748b', fontWeight: c.active ? 600 : 500 }}>
              <span style={{ fontSize: 12 }}>{c.emoji}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
    panel = (
      <div style={{ ...panelBase, width: 150, background: '#fff' }}>
        <div style={{ padding: '13px 13px 8px', fontSize: 12.5, fontWeight: 700, color: '#1e293b' }}>
          Cloner POC <span style={{ color: '#94a3b8', fontWeight: 500 }}>· Pages</span>
        </div>
        <div style={{ padding: '0 8px', flex: 1, overflow: 'auto' }}>
          {PAGES.map((p) => <PageRow key={p.name} p={p} accent={accent} />)}
        </div>
      </div>
    );
  } else {
    // 'pages' — stacked drill-down with a back row, heading "<canvas> · Pages"
    panel = (
      <div style={panelBase}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 6px',
          fontSize: 11, color: '#94a3b8', fontWeight: 600, cursor: 'pointer' }}>
          <span style={{ fontSize: 13 }}>‹</span> Canvases
        </div>
        <div style={{ padding: '0 14px 8px', fontSize: 13.5, fontWeight: 700, color: '#1e293b' }}>
          Cloner POC <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: 12 }}>· Pages</span>
        </div>
        <div style={{ padding: '0 8px', flex: 1, overflow: 'auto' }}>
          {PAGES.map((p) => <PageRow key={p.name} p={p} accent={accent} />)}
        </div>
      </div>
    );
  }

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
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <DarkRail accent={accent} zActive={s === 'workspace'} />
        {extraColumn}
        {panel}
        <Canvas />
        {overlay}
      </div>
    </div>
  );
}
