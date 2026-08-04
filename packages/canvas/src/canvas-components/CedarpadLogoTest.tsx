// cedarpad logo stress-test — runs the 4 finalist marks through the gauntlet that
// actually decides a logo: brand size, 20px, favicon 16px, monochrome single-ink,
// on-light, and in the shell rail. The marks that survive every column are the real
// candidates. Marks are parametric (size + primary/secondary/accent inks).
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
  light: 'oklch(0.96 0.004 75)',
  ink: 'oklch(0.26 0.012 60)',
  inkSub: 'oklch(0.50 0.012 60)',
};
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";

type MP = { s: number; p: string; q: string; a: string };
function Mark({ k, s, p, q, a }: MP & { k: string }) {
  const props = { width: s, height: s, viewBox: '0 0 48 48', fill: 'none' };
  if (k === 'pad') return (
    <svg {...props}>
      <rect x="6" y="8" width="36" height="32" rx="9" stroke={p} strokeWidth="2" />
      <line x1="13" y1="31" x2="26" y2="31" stroke={q} strokeWidth="2" strokeLinecap="round" />
      <line x1="13" y1="24" x2="22" y2="24" stroke={q} strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="18" r="3.6" fill={a} />
    </svg>
  );
  if (k === 'rings') return (
    <svg {...props}>
      <circle cx="22" cy="25" r="15" stroke={q} strokeWidth="2" />
      <circle cx="22" cy="25" r="10" stroke={p} strokeWidth="2" />
      <circle cx="22" cy="25" r="5.2" stroke={a} strokeWidth="2.4" />
      <circle cx="22" cy="25" r="1.7" fill={a} />
    </svg>
  );
  if (k === 'frond') {
    const ys = [34, 29, 24, 19, 14], sp = [7, 6.2, 5, 3.6, 2.2];
    return (
      <svg {...props} stroke={a} strokeWidth="2" strokeLinecap="round">
        <line x1="24" y1="40" x2="24" y2="9" />
        {ys.map((y, i) => (<g key={y}><line x1="24" y1={y} x2={24 - sp[i]} y2={y - 4} /><line x1="24" y1={y} x2={24 + sp[i]} y2={y - 4} /></g>))}
      </svg>
    );
  }
  // grid
  const dots: Array<[number, number]> = [];
  for (const x of [13, 24, 35]) for (const y of [14, 24, 34]) dots.push([x, y]);
  return (
    <svg {...props}>
      {dots.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" fill={q} />)}
      <line x1="24" y1="24" x2="35" y2="14" stroke={a} strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="24" r="3.4" fill={a} />
      <circle cx="35" cy="14" r="3.4" fill={a} />
    </svg>
  );
}

// per-mark brand accent (frond is green, the rest ember)
const MARKS = [
  { k: 'pad', name: 'Pad + spark', brand: C.ember },
  { k: 'rings', name: 'Growth rings', brand: C.ember },
  { k: 'frond', name: 'Cedar frond', brand: C.green },
  { k: 'grid', name: 'Canvas grid', brand: C.ember },
];

function Cell({ bg, children, w = 56 }: { bg: string; children: React.ReactNode; w?: number }) {
  return <div style={{ width: w, height: 52, borderRadius: 8, background: bg, display: 'grid', placeItems: 'center',
    boxShadow: `inset 0 0 0 1px ${bg === C.void ? C.line : 'transparent'}`, flexShrink: 0 }}>{children}</div>;
}
function Head({ children, w = 56 }: { children: React.ReactNode; w?: number }) {
  return <div style={{ width: w, textAlign: 'center', font: `500 9px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint, flexShrink: 0 }}>{children}</div>;
}

export default function CedarpadLogoTest() {
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: C.void, color: C.text,
      fontFamily: SANS, borderRadius: 14, overflow: 'auto', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <div style={{ padding: '18px 20px 22px' }}>
        <div style={{ font: `600 16px ${SANS}`, letterSpacing: '-0.01em' }}>cedarpad · logo stress test</div>
        <div style={{ font: `500 10.5px ${MONO}`, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted, marginTop: 4 }}>the gauntlet · scale · mono · on-light · in the rail</div>

        {/* column heads */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18, paddingLeft: 92 }}>
          <Head>Brand</Head><Head>20px</Head><Head>16px</Head><Head>Mono</Head><Head>On light</Head>
        </div>

        {/* rows */}
        {MARKS.map(({ k, name, brand }) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: `1px solid ${C.line}` }}>
            <div style={{ width: 84, flexShrink: 0, font: `400 12px ${SANS}`, color: C.text }}>{name}</div>
            <Cell bg={C.void}><Mark k={k} s={40} p={C.text} q={C.muted} a={brand} /></Cell>
            <Cell bg={C.void}><Mark k={k} s={20} p={C.text} q={C.muted} a={brand} /></Cell>
            <Cell bg={C.void}><Mark k={k} s={16} p={C.text} q={C.muted} a={brand} /></Cell>
            <Cell bg={C.void}><Mark k={k} s={32} p={C.text} q={C.text} a={C.text} /></Cell>
            <Cell bg={C.light}><Mark k={k} s={32} p={C.ink} q={C.inkSub} a={brand} /></Cell>
          </div>
        ))}

        {/* in the rail */}
        <div style={{ marginTop: 20, font: `500 9px ${MONO}`, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint, marginBottom: 8 }}>In the shell rail (replaces the Z)</div>
        <div style={{ display: 'flex', gap: 14 }}>
          {MARKS.map(({ k, name, brand }) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 44, height: 132, background: C.void, border: `1px solid ${C.line}`, borderRadius: 10,
                display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8, gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: C.raised, display: 'grid', placeItems: 'center' }}>
                  <Mark k={k} s={22} p={C.text} q={C.muted} a={brand} />
                </div>
                <div style={{ width: 22, height: 2, background: C.line, borderRadius: 2 }} />
                <div style={{ width: 18, height: 18, borderRadius: 6, background: C.raised }} />
                <div style={{ width: 18, height: 18, borderRadius: 6, background: C.raised }} />
              </div>
              <div style={{ font: `400 10px ${SANS}`, color: C.faint }}>{name.split(' ')[0]}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
