import { type ReactNode } from 'react';

// cedarpad navigation shell, built on the DESIGN.md tokens (warm graphite + one
// cedar ember). Structure matches the chosen ShellV4 (workspace > canvas > pages;
// trimmed rail; breadcrumb pages panel; headerless canvas).
//
// ONE active marker: a 2px Cedar Ember left stripe (hugging the element's left edge)
// plus a Surface Overlay fill that sits one tone above its local ground. Used on the
// rail Z, the Canvases icon, the list rows, and the active workspace row (which adds
// a menu check as a secondary marker). Cedar is reserved for live/active state
// (Cedar-Means-Live).
// Props: { accent?: string, label?: string, view?: 'workspace' | 'canvases' | 'pages' }

interface Props { accent?: string; label?: string; view?: 'workspace' | 'canvases' | 'pages' }

const C = {
  void: 'oklch(0.16 0 0)',
  surface: 'oklch(0.21 0 0)',
  raised: 'oklch(0.25 0 0)',
  overlay: 'oklch(0.29 0 0)',
  line: 'oklch(0.32 0 0)',
  lineStrong: 'oklch(0.41 0 0)',
  text: 'oklch(0.93 0.008 75)',
  muted: 'oklch(0.69 0.014 65)',
  faint: 'oklch(0.60 0.014 60)',
};
const SHADOW_FLOAT = `0 1px 2px oklch(0.10 0.01 60 / 0.5)`;
const SHADOW_LIFT = `0 8px 24px oklch(0.07 0.01 60 / 0.55)`;
const RAD = { sm: 6, md: 10, lg: 14 }; // rounded.sm / md / lg
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";

const WORKSPACES = [
  { name: 'Zabaca', glyph: 'Z', active: true },
  { name: 'Personal', glyph: 'P' },
];
const CANVASES = [
  { name: 'Cloner POC', count: 5, active: true },
  { name: 'Landing variants', count: 8 },
  { name: 'Avatar pipeline', count: 5 },
  { name: 'Fredrin', count: 6 },
  { name: 'Scratch', count: 3 },
];
const PAGES = [
  { name: 'Overview', active: true },
  { name: 'Pipeline' },
  { name: 'Avatar tests' },
  { name: 'B-roll' },
  { name: 'Notes' },
];

const ICON = { stroke: 'currentColor', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function IconCanvases() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" {...ICON}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></svg>);
}
function IconGear() {
  return (<svg width="17" height="17" viewBox="0 0 24 24" {...ICON}><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 15H2.5a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.5a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1A1.7 1.7 0 0 0 21.4 11h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z" /></svg>);
}
function IconCheck({ color }: { color: string }) {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>);
}

// the one active idiom: a 2px cedar stripe hugging the element's own left edge.
function Stripe({ accent }: { accent: string }) {
  return <span style={{ position: 'absolute', left: 0, top: 7, bottom: 7, width: 2, borderRadius: 2, background: accent }} />;
}

function Rail({ accent, zActive, canvasesActive }: { accent: string; zActive: boolean; canvasesActive: boolean }) {
  const SIZE = 36;
  return (
    <div style={{ width: 52, flexShrink: 0, background: C.void, borderRight: `1px solid ${C.line}`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 6 }}>
      <button className="cdrsh-icon" title="Switch workspace · Zabaca" style={{ position: 'relative', width: SIZE, height: SIZE,
        borderRadius: RAD.md, display: 'grid', placeItems: 'center', border: 'none', cursor: 'pointer', font: `700 14px ${SANS}`,
        color: C.text, background: zActive ? C.overlay : C.raised, marginBottom: 4, overflow: 'hidden' }}>
        {zActive && <Stripe accent={accent} />}Z
      </button>
      <button className="cdrsh-icon" title="Canvases" style={{ position: 'relative', width: SIZE, height: SIZE,
        borderRadius: RAD.md, display: 'grid', placeItems: 'center', cursor: 'pointer', border: 'none', overflow: 'hidden',
        color: canvasesActive ? C.text : C.muted, background: canvasesActive ? C.overlay : 'transparent' }}>
        {canvasesActive && <Stripe accent={accent} />}<IconCanvases />
      </button>
      <div style={{ marginTop: 'auto', marginBottom: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button className="cdrsh-icon" title="Settings" style={{ width: SIZE, height: SIZE, borderRadius: RAD.md, display: 'grid',
          placeItems: 'center', color: C.muted, background: 'transparent', border: 'none', cursor: 'pointer' }}><IconGear /></button>
        <button className="cdrsh-icon" title="James" style={{ width: 28, height: 28, borderRadius: '50%', background: C.raised,
          color: C.text, border: 'none', font: `700 11px ${SANS}`, cursor: 'pointer' }}>J</button>
      </div>
    </div>
  );
}

function Row({ name, count, active, accent }: { name: string; count?: number; active?: boolean; accent: string }) {
  return (
    <div className={active ? 'cdrsh-row cdrsh-row-active' : 'cdrsh-row'} style={{ position: 'relative', overflow: 'hidden',
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 14px', borderRadius: RAD.md, cursor: 'pointer',
      marginBottom: 1, font: `${active ? 500 : 400} 13px ${SANS}`,
      background: active ? C.overlay : 'transparent', color: active ? C.text : C.muted }}>
      {active && <Stripe accent={accent} />}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{name}</span>
      {count != null && <span style={{ font: `400 11px ${MONO}`, color: C.faint }}>{count}</span>}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div style={{ padding: '4px 14px 6px', font: `500 10.5px ${MONO}`, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.muted }}>{children}</div>;
}

// workspace switcher dropdown, anchored off the rail's Z. Active workspace uses the
// SAME stripe + Overlay fill as every other active element, plus a menu check.
// Floating surface separated by a line-strong ring + Lift shadow.
function WorkspacePopover({ accent }: { accent: string }) {
  return (
    <div style={{ position: 'absolute', top: 8, left: 58, width: 198, zIndex: 5, background: C.raised,
      borderRadius: RAD.lg, boxShadow: `${SHADOW_LIFT}, 0 0 0 1px ${C.lineStrong}`, padding: 7 }}>
      <Label>Workspaces</Label>
      {WORKSPACES.map((w) => (
        <div key={w.name} className={w.active ? 'cdrsh-row cdrsh-row-active' : 'cdrsh-row'} style={{ position: 'relative', overflow: 'hidden',
          display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px 7px 12px', borderRadius: RAD.md, cursor: 'pointer', marginBottom: 1,
          background: w.active ? C.overlay : 'transparent' }}>
          {w.active && <Stripe accent={accent} />}
          <div style={{ width: 24, height: 24, borderRadius: RAD.sm, background: C.raised, color: C.text,
            display: 'grid', placeItems: 'center', font: `700 11px ${SANS}`, boxShadow: `inset 0 0 0 1px ${C.line}` }}>{w.glyph}</div>
          <span style={{ font: `${w.active ? 500 : 400} 13px ${SANS}`, color: w.active ? C.text : C.muted }}>{w.name}</span>
          {w.active && <span style={{ marginLeft: 'auto', display: 'grid', placeItems: 'center' }}><IconCheck color={accent} /></span>}
        </div>
      ))}
      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 5, paddingTop: 5 }}>
        <div className="cdrsh-row" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px',
          borderRadius: RAD.md, color: C.muted, font: `400 13px ${SANS}`, cursor: 'pointer' }}>
          <span style={{ width: 24, textAlign: 'center', font: `400 17px ${SANS}`, lineHeight: 1, color: C.muted }}>+</span>
          New workspace
        </div>
      </div>
    </div>
  );
}

// headerless canvas: a chat card (live "thinking" pill in the accent) and a placed
// component card, both rendered in the system so the scaffold reads as real use.
function Canvas({ accent }: { accent: string }) {
  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: C.void,
      backgroundImage: 'radial-gradient(oklch(0.30 0 0) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
      <div style={{ position: 'absolute', top: 30, left: 34, width: 138, borderRadius: RAD.lg, overflow: 'hidden',
        background: C.surface, boxShadow: `${SHADOW_FLOAT}, 0 0 0 1px ${C.line}` }}>
        <div style={{ background: C.raised, color: C.text, font: `600 12px ${SANS}`, padding: '7px 10px' }}>Chat 1</div>
        <div style={{ padding: 10 }}>
          <div style={{ height: 5, background: C.overlay, borderRadius: 3, marginBottom: 5 }} />
          <div style={{ height: 5, background: C.overlay, borderRadius: 3, width: '72%' }} />
          <div style={{ marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 5, font: `500 9px ${MONO}`,
            letterSpacing: '0.08em', textTransform: 'uppercase', color: accent }}>
            <span style={{ width: 5, height: 5, borderRadius: 999, background: accent }} />thinking
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', top: 138, left: 210, width: 130, borderRadius: RAD.lg, overflow: 'hidden',
        background: C.surface, boxShadow: `${SHADOW_FLOAT}, 0 0 0 1px ${C.line}` }}>
        <div style={{ padding: '7px 10px', font: `500 9px ${MONO}`, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: C.muted, borderBottom: `1px solid ${C.line}` }}>tam_card</div>
        <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ height: 5, background: C.overlay, borderRadius: 3 }} />
          <div style={{ height: 5, background: C.overlay, borderRadius: 3, width: '80%' }} />
          <div style={{ height: 5, background: C.overlay, borderRadius: 3, width: '55%' }} />
        </div>
      </div>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <line x1="172" y1="92" x2="210" y2="158" stroke={C.line} strokeWidth="1.5" strokeDasharray="4 3" />
      </svg>
    </div>
  );
}

export default function CedarShell({ accent = 'oklch(0.68 0.145 45)', label = '', view = 'pages' }: Props) {
  const v = view; // static scaffold: render the view as given
  const css = `
    .cdrsh-row:hover { background:${C.raised}; color:${C.text}; }
    .cdrsh-row-active:hover { background:${C.overlay}; }
    .cdrsh-icon:hover { background:${C.overlay}; color:${C.text}; }
    .cdrsh-icon:focus-visible, .cdrsh-row:focus-visible { outline:2px solid ${accent}; outline-offset:2px; }
    .cdrsh-add:hover { color:${C.text}; }
  `;

  const panel = (
    <div style={{ width: 192, flexShrink: 0, background: C.surface, borderRight: `1px solid ${C.line}`,
      display: 'flex', flexDirection: 'column' }}>
      {v === 'canvases' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px 2px' }}>
            <span style={{ font: `600 13px ${SANS}`, color: C.text }}>Canvases</span>
            <button className="cdrsh-add" title="New canvas" style={{ marginLeft: 'auto', background: 'transparent', border: 'none',
              color: C.muted, font: `400 17px ${SANS}`, lineHeight: 1, cursor: 'pointer' }}>+</button>
          </div>
          <div style={{ padding: '6px 8px', flex: 1, overflow: 'auto' }}>
            {CANVASES.map((c) => <Row key={c.name} name={c.name} count={c.count} active={c.active} accent={accent} />)}
          </div>
        </>
      ) : (
        <>
          <div style={{ padding: '13px 14px 2px', font: `500 11px ${SANS}`, color: C.muted, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ cursor: 'pointer' }}>Canvases</span>
            <span style={{ color: C.muted }}>›</span>
            <span style={{ color: C.text }}>Cloner POC</span>
          </div>
          <Label>Pages</Label>
          <div style={{ padding: '0 8px', flex: 1, overflow: 'auto' }}>
            {PAGES.map((p) => <Row key={p.name} name={p.name} active={p.active} accent={accent} />)}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: SANS, overflow: 'hidden',
      borderRadius: RAD.lg, background: C.surface, boxShadow: `${SHADOW_LIFT}, 0 0 0 1px ${C.line}` }}>
      <style>{css}</style>
      {label && (
        <div style={{ flexShrink: 0, padding: '8px 14px', background: C.void, color: C.muted, borderBottom: `1px solid ${C.line}`,
          font: `500 10.5px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent }} />{label}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <Rail accent={accent} zActive={v === 'workspace'} canvasesActive={v !== 'workspace'} />
        {panel}
        <Canvas accent={accent} />
        {v === 'workspace' && <WorkspacePopover accent={accent} />}
      </div>
    </div>
  );
}
