// cedarpad logo studies — built on the design system (warm graphite, ember = the live
// spark; banked evergreen green for the foliage mark). Each row is a real lockup:
// mark + wordmark + concept name + a shrunk favicon tile to test the mark small.
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
  green: 'oklch(0.62 0.13 152)',
};
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";

// ---- the marks (48x48 viewBox) ----
function MarkPad() {
  return (
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="8" width="36" height="32" rx="9" stroke={C.text} strokeWidth="2" />
      <line x1="13" y1="31" x2="26" y2="31" stroke={C.muted} strokeWidth="2" strokeLinecap="round" />
      <line x1="13" y1="24" x2="22" y2="24" stroke={C.muted} strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="18" r="3.6" fill={C.ember} />
    </svg>
  );
}
function MarkRings() {
  return (
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
      <circle cx="22" cy="25" r="15" stroke={C.line} strokeWidth="2" />
      <circle cx="22" cy="25" r="10" stroke={C.muted} strokeWidth="2" />
      <circle cx="22" cy="25" r="5.2" stroke={C.ember} strokeWidth="2.4" />
      <circle cx="22" cy="25" r="1.7" fill={C.ember} />
    </svg>
  );
}
function MarkFrond() {
  const ys = [34, 29, 24, 19, 14];
  const spread = [7, 6.2, 5, 3.6, 2.2];
  return (
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none" stroke={C.green} strokeWidth="2" strokeLinecap="round">
      <line x1="24" y1="40" x2="24" y2="9" />
      {ys.map((y, i) => (
        <g key={y}>
          <line x1="24" y1={y} x2={24 - spread[i]} y2={y - 4} />
          <line x1="24" y1={y} x2={24 + spread[i]} y2={y - 4} />
        </g>
      ))}
    </svg>
  );
}
function MarkGrid() {
  const dots: Array<[number, number]> = [];
  for (const x of [13, 24, 35]) for (const y of [14, 24, 34]) dots.push([x, y]);
  return (
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
      {dots.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" fill={C.muted} />)}
      <line x1="24" y1="24" x2="35" y2="14" stroke={C.ember} strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="24" r="3.4" fill={C.ember} />
      <circle cx="35" cy="14" r="3.4" fill={C.ember} />
    </svg>
  );
}

function Wordmark() {
  return <span style={{ font: `600 23px ${SANS}`, letterSpacing: '-0.015em', color: C.text }}>cedarpad</span>;
}

const ROWS = [
  { Mark: MarkPad, name: 'Pad + spark', note: 'the pad, one live ember cursor', tile: C.surface },
  { Mark: MarkRings, name: 'Growth rings', note: 'cut-cedar wood identity', tile: C.surface },
  { Mark: MarkFrond, name: 'Cedar frond', note: 'evergreen / marketing mark', tile: C.surface },
  { Mark: MarkGrid, name: 'Canvas grid', note: 'spatial board, agent links two nodes', tile: C.surface },
];

export default function CedarpadLogos() {
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: C.void, color: C.text,
      fontFamily: SANS, borderRadius: 14, overflow: 'auto', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <div style={{ padding: '18px 20px 20px' }}>
        <div style={{ font: `600 16px ${SANS}`, letterSpacing: '-0.01em' }}>cedarpad · logo studies</div>
        <div style={{ font: `500 10.5px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted, marginTop: 4 }}>4 directions · ember = live, green = identity</div>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column' }}>
          {ROWS.map(({ Mark, name, note, tile }, i) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${C.line}` }}>
              {/* mark */}
              <div style={{ width: 48, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Mark /></div>
              {/* lockup */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Wordmark />
                <div style={{ font: `400 12px ${SANS}`, color: C.faint, marginTop: 3 }}>{note}</div>
              </div>
              {/* concept name */}
              <div style={{ font: `500 10.5px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.muted, width: 96, textAlign: 'right', flexShrink: 0 }}>{name}</div>
              {/* favicon tile (mark shrunk) */}
              <div style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, display: 'grid', placeItems: 'center',
                background: tile ?? 'transparent', boxShadow: tile ? `inset 0 0 0 1px ${C.line}` : 'none', overflow: 'hidden' }}>
                <div style={{ transform: 'scale(0.58)' }}><Mark /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
