// cedarpad pad+spark — physical / large-format test. Shows the 3 mark treatments
// (app 2-color, merch simplified 1-color, solid knockout) and applications: building
// sign, banner, embroidered cap, tee (dark + light). Proves the mark survives
// signage scale and single-thread embroidery once the thin interior lines are dropped.
import * as React from 'react';

const C = {
  void: 'oklch(0.16 0 0)',
  surface: 'oklch(0.21 0 0)',
  raised: 'oklch(0.25 0 0)',
  line: 'oklch(0.32 0 0)',
  text: 'oklch(0.93 0.008 75)',
  muted: 'oklch(0.69 0.014 65)',
  faint: 'oklch(0.60 0.014 60)',
  ember: 'oklch(0.68 0.145 45)',
  light: 'oklch(0.95 0.006 75)',
  ink: 'oklch(0.24 0.012 60)',
};
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";

// variant: 'app' (2-color, thin lines), 'merch' (1-color thick outline, no lines),
// 'solid' (filled pad, spark knocked out in bg color)
function PadMark({ s = 44, variant, color, bg }: { s?: number; variant: 'app' | 'merch' | 'solid'; color: string; bg?: string }) {
  const p = { width: s, height: s, viewBox: '0 0 48 48', fill: 'none' };
  if (variant === 'app') return (
    <svg {...p}>
      <rect x="6" y="8" width="36" height="32" rx="9" stroke={color} strokeWidth="2" />
      <line x1="13" y1="31" x2="26" y2="31" stroke={C.muted} strokeWidth="2" strokeLinecap="round" />
      <line x1="13" y1="24" x2="22" y2="24" stroke={C.muted} strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="18" r="3.6" fill={C.ember} />
    </svg>
  );
  if (variant === 'merch') return (
    <svg {...p}>
      <rect x="7" y="9" width="34" height="30" rx="9" stroke={color} strokeWidth="3.6" />
      <circle cx="31" cy="19" r="4.2" fill={color} />
    </svg>
  );
  // solid knockout
  return (
    <svg {...p}>
      <rect x="6" y="8" width="36" height="32" rx="10" fill={color} />
      <circle cx="31" cy="19" r="4.4" fill={bg ?? C.void} />
    </svg>
  );
}

function Tile({ label, bg, children, w = 120 }: { label: string; bg: string; children: React.ReactNode; w?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ width: w, height: 96, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center',
        boxShadow: `inset 0 0 0 1px ${C.line}`, overflow: 'hidden' }}>{children}</div>
      <div style={{ font: `400 10px ${SANS}`, color: C.faint, textAlign: 'center' }}>{label}</div>
    </div>
  );
}

// ---- application mockups (schematic) ----
function Cap({ thread }: { thread: string }) {
  return (
    <svg width="92" height="72" viewBox="0 0 92 72">
      <path d="M14 50 C14 22 78 22 78 50 Z" fill={C.ink} />
      <path d="M10 50 Q46 70 82 50 L78 50 Q46 60 14 50 Z" fill="oklch(0.19 0.012 60)" />
      <g transform="translate(34,26) scale(0.5)"><PadMark s={48} variant="merch" color={thread} /></g>
    </svg>
  );
}
function Tee({ garment, mark }: { garment: string; mark: string }) {
  return (
    <svg width="84" height="80" viewBox="0 0 84 80">
      <path d="M26 10 L34 6 Q42 12 50 6 L58 10 L72 22 L62 32 L58 28 L58 74 L26 74 L26 28 L22 32 L12 22 Z" fill={garment} stroke={C.line} strokeWidth="1" />
      <g transform="translate(33,28) scale(0.42)"><PadMark s={48} variant="merch" color={mark} /></g>
      <text x="42" y="52" textAnchor="middle" fill={mark} style={{ font: `700 8px ${SANS}` }}>cedarpad</text>
    </svg>
  );
}

export default function CedarpadMerch() {
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: C.void, color: C.text,
      fontFamily: SANS, borderRadius: 14, overflow: 'auto', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <div style={{ padding: '18px 20px 22px' }}>
        <div style={{ font: `600 16px ${SANS}`, letterSpacing: '-0.01em' }}>pad + spark · physical / merch test</div>
        <div style={{ font: `500 10.5px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted, marginTop: 4 }}>simplify for embroidery + signage · drop the thin interior lines</div>

        {/* mark treatments */}
        <div style={{ font: `500 9px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint, margin: '18px 0 8px' }}>Mark treatments</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Tile label="App (2-color, thin)" bg={C.surface}><PadMark variant="app" color={C.text} /></Tile>
          <Tile label="Merch (1-color, thick)" bg={C.surface}><PadMark variant="merch" color={C.ember} /></Tile>
          <Tile label="Solid knockout" bg={C.surface}><PadMark variant="solid" color={C.ember} bg={C.surface} /></Tile>
          <Tile label="1-color on light" bg={C.light}><PadMark variant="merch" color={C.ink} /></Tile>
        </div>

        {/* applications */}
        <div style={{ font: `500 9px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint, margin: '20px 0 8px' }}>Applications</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {/* building sign */}
          <Tile label="Building sign" bg={C.ink} w={150}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <PadMark s={32} variant="solid" color={C.text} bg={C.ink} />
              <span style={{ font: `600 17px ${SANS}`, letterSpacing: '-0.01em', color: C.text }}>cedarpad</span>
            </div>
          </Tile>
          {/* banner */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 60, height: 96, borderRadius: 8, background: C.ember, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 8, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
              <PadMark s={34} variant="solid" color={C.ember} bg={C.void} />
              <span style={{ font: `700 9px ${SANS}`, color: C.void, writingMode: 'vertical-rl', letterSpacing: '0.04em' }}>cedarpad</span>
            </div>
            <div style={{ font: `400 10px ${SANS}`, color: C.faint }}>Banner</div>
          </div>
          {/* cap */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 100, height: 96, borderRadius: 10, background: C.surface, display: 'grid', placeItems: 'center', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
              <Cap thread={C.ember} />
            </div>
            <div style={{ font: `400 10px ${SANS}`, color: C.faint }}>Cap · 1 thread</div>
          </div>
          {/* tee dark */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 92, height: 96, borderRadius: 10, background: C.surface, display: 'grid', placeItems: 'center', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
              <Tee garment={C.ink} mark={C.ember} />
            </div>
            <div style={{ font: `400 10px ${SANS}`, color: C.faint }}>Tee · dark</div>
          </div>
          {/* tee light */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 92, height: 96, borderRadius: 10, background: C.surface, display: 'grid', placeItems: 'center', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
              <Tee garment={C.light} mark={C.ink} />
            </div>
            <div style={{ font: `400 10px ${SANS}`, color: C.faint }}>Tee · light</div>
          </div>
        </div>

        <div style={{ marginTop: 18, font: `400 11px ${SANS}`, color: C.muted, lineHeight: 1.5 }}>
          Verdict: signage and banners use the <b style={{ color: C.text }}>solid knockout</b>; caps/shirts use the <b style={{ color: C.text }}>1-color merch</b> mark (thick stroke, no interior lines). The thin app version stays on screens only.
        </div>
      </div>
    </div>
  );
}
