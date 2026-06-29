// cedarpad design-system preview. Renders the warm-graphite neutral system plus a
// pluggable accent so we can compare accent directions (wood ember vs foliage green)
// on identical neutrals. Self-contained; accent defaults to cedar-ember.
import * as React from 'react';

const C = {
  void: 'oklch(0.16 0.010 60)',
  surface: 'oklch(0.21 0.012 60)',
  raised: 'oklch(0.25 0.013 60)',
  overlay: 'oklch(0.29 0.014 60)',
  line: 'oklch(0.32 0.016 60)',
  lineStrong: 'oklch(0.41 0.018 60)',
  text: 'oklch(0.93 0.008 75)',
  muted: 'oklch(0.69 0.014 65)',
  faint: 'oklch(0.60 0.014 60)',
  danger: 'oklch(0.62 0.18 25)',
  success: 'oklch(0.65 0.12 150)',
  warning: 'oklch(0.80 0.12 85)',
};
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";

interface Props {
  title?: string;
  subtitle?: string;
  accent?: string;
  accentHi?: string;
  accentQuiet?: string;
  onAccent?: string;
  hideStatus?: boolean;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ font: `500 11px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted, margin: '0 0 8px' }}>{children}</div>;
}
function Swatch({ name, val, big }: { name: string; val: string; big?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ height: big ? 52 : 38, borderRadius: 8, background: val, boxShadow: `inset 0 0 0 1px ${C.line}` }} />
      <div style={{ font: `400 11px ${SANS}`, color: C.text, lineHeight: 1.3 }}>{name}</div>
    </div>
  );
}

export default function CedarPalette({
  title = 'cedarpad',
  subtitle = 'The Lit Drafting Table — warm graphite, one cedar ember.',
  accent = 'oklch(0.68 0.145 45)',
  accentHi = 'oklch(0.75 0.14 45)',
  accentQuiet = 'oklch(0.45 0.08 45)',
  onAccent = 'oklch(0.18 0.012 60)',
  hideStatus = false,
}: Props) {
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: C.void, color: C.text, fontFamily: SANS, borderRadius: 14, overflow: 'auto', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <div style={{ padding: '18px 20px 22px' }}>
        <div style={{ font: `600 19px ${SANS}`, letterSpacing: '-0.01em' }}>{title}</div>
        <div style={{ font: `400 13px ${SANS}`, color: C.muted, marginTop: 3 }}>{subtitle}</div>

        {/* Accent */}
        <div style={{ marginTop: 22 }}>
          <Label>Accent · means live</Label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
            <Swatch name="accent" val={accent} big />
            <Swatch name="accent-hi" val={accentHi} big />
            <Swatch name="accent-quiet" val={accentQuiet} big />
            <Swatch name="on-accent" val={onAccent} big />
          </div>
        </div>

        {/* Neutral ramp */}
        <div style={{ marginTop: 20 }}>
          <Label>Warm graphite · hue 60</Label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
            <Swatch name="void" val={C.void} />
            <Swatch name="surface" val={C.surface} />
            <Swatch name="raised" val={C.raised} />
            <Swatch name="overlay" val={C.overlay} />
            <Swatch name="line" val={C.line} />
            <Swatch name="line-strong" val={C.lineStrong} />
            <Swatch name="text" val={C.text} />
            <Swatch name="muted" val={C.muted} />
          </div>
        </div>

        {/* Status */}
        {!hideStatus && (
          <div style={{ marginTop: 20 }}>
            <Label>Status · never decorative</Label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
              <Swatch name="danger" val={C.danger} />
              <Swatch name="success" val={C.success} />
              <Swatch name="warning" val={C.warning} />
              <Swatch name="faint" val={C.faint} />
            </div>
          </div>
        )}

        {/* Specimens */}
        <div style={{ marginTop: 24 }}>
          <Label>Specimens</Label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            <button style={{ background: accent, color: onAccent, font: `600 13px ${SANS}`, padding: '8px 14px', border: 'none', borderRadius: 10, cursor: 'pointer' }}>New chat</button>
            <button style={{ background: C.raised, color: C.text, font: `400 13px ${SANS}`, padding: '8px 14px', border: `1px solid ${C.line}`, borderRadius: 10, cursor: 'pointer' }}>Cancel</button>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: C.raised, color: C.muted, font: `400 12.5px ${MONO}`, padding: '3px 7px', borderRadius: 6 }}>read_canvas<span style={{ color: C.faint, fontSize: 11 }}>0.4s</span></span>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {/* nav */}
            <div style={{ background: C.surface, borderRadius: 10, padding: 4, width: 200 }}>
              <div style={{ position: 'relative', color: C.text, font: `400 13px ${SANS}`, padding: '8px 10px 8px 14px', borderRadius: 8, background: C.overlay }}>
                <span style={{ position: 'absolute', left: 4, top: 8, bottom: 8, width: 2, borderRadius: 2, background: accent }} />Overview
              </div>
              <div style={{ color: C.muted, font: `400 13px ${SANS}`, padding: '8px 10px 8px 14px' }}>Pipeline</div>
              <div style={{ color: C.muted, font: `400 13px ${SANS}`, padding: '8px 10px 8px 14px' }}>Components</div>
            </div>
            {/* chat card */}
            <div style={{ width: 220, background: C.surface, borderRadius: 14, overflow: 'hidden', boxShadow: `0 1px 2px oklch(0.10 0.01 60 / 0.5), 0 0 0 1px ${C.line}` }}>
              <div style={{ background: C.raised, color: C.text, font: `600 15px ${SANS}`, padding: '10px 14px' }}>Chat 4</div>
              <div style={{ padding: 14 }}>
                <div style={{ color: C.text, font: `400 13px ${SANS}`, lineHeight: 1.55 }}>The agent's reply streams here.</div>
                <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, color: accent, font: `500 11px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: accent }} />thinking
                </div>
                <input placeholder="Ask, or sketch on the pad" style={{ marginTop: 12, width: '100%', boxSizing: 'border-box', background: C.void, color: C.text, font: `400 13px ${SANS}`, padding: '8px 12px', border: `1px solid ${accent}`, borderRadius: 10 }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
