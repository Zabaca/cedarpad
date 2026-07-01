// Hero variation: brutalist / bold. Solid color block, huge sans type, hard edges.
import type { HeroProps } from './FredrinHeroSynth';

export default function FredrinHeroBold({
  brand = 'FREDRIN',
  headline = 'Ship at arcade speed.',
  sub = 'From idea to live before the loading screen finishes.',
  cta = 'GET STARTED',
}: HeroProps) {
  return (
    <div style={{ width: '100%', height: '100%', background: '#e8ff3a', color: '#0a0a0a', fontFamily: '"Archivo", "Helvetica Neue", Arial, sans-serif', display: 'flex', flexDirection: 'column', padding: 28, boxSizing: 'border-box', position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontWeight: 900, letterSpacing: -0.5, fontSize: 18, background: '#0a0a0a', color: '#e8ff3a', padding: '4px 10px' }}>{brand}</span>
        <span style={{ fontSize: 12, fontWeight: 800, border: '2px solid #0a0a0a', padding: '4px 10px', transform: 'rotate(3deg)' }}>v1.0 / LIVE</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 64, lineHeight: 0.92, fontWeight: 900, letterSpacing: -2, textTransform: 'uppercase' }}>{headline}</h1>
        <p style={{ marginTop: 16, fontSize: 16, fontWeight: 600, maxWidth: 460, lineHeight: 1.4 }}>{sub}</p>
      </div>
      <button style={{ alignSelf: 'flex-start', cursor: 'pointer', fontFamily: 'inherit', background: '#0a0a0a', color: '#e8ff3a', border: 'none', padding: '16px 30px', fontSize: 16, fontWeight: 900, letterSpacing: 0.5, boxShadow: '6px 6px 0 rgba(10,10,10,0.25)' }}>{cta} ↗</button>
    </div>
  );
}
