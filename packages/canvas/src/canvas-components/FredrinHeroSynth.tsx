// Hero variation: synthwave / retro-arcade. Shares the HeroProps interface so the
// cycler can pass the same copy to every variation.
export interface HeroProps {
  brand?: string;
  headline?: string;
  sub?: string;
  cta?: string;
}

export default function FredrinHeroSynth({
  brand = 'FREDRIN',
  headline = 'Ship at arcade speed.',
  sub = 'From idea to live before the loading screen finishes.',
  cta = 'Insert coin →',
}: HeroProps) {
  const neon = 'linear-gradient(92deg,#22d3ee,#a855f7 50%,#ec4899)';
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: 'radial-gradient(120% 90% at 50% 0%,#2b0b4a,#160a32 50%,#08040f)', fontFamily: '"Space Grotesk",ui-sans-serif,system-ui', color: '#e9e7ff' }}>
      <svg viewBox="0 0 800 200" preserveAspectRatio="none" style={{ position: 'absolute', bottom: 0, width: '100%', height: '45%', opacity: 0.5 }}>
        <g stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="1" fill="none">
          {Array.from({ length: 13 }).map((_, i) => <line key={i} x1={400 + (i - 6) * 22} y1="6" x2={400 + (i - 6) * 150} y2="200" />)}
          {[24, 56, 100, 156].map((y, i) => <line key={`h${i}`} x1="0" y1={y} x2="800" y2={y} />)}
        </g>
      </svg>
      <div style={{ position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)', width: 130, height: 130, borderRadius: '50%', background: 'linear-gradient(#ffd36e,#ff7ac6 55%,#a855f7)', boxShadow: '0 0 60px rgba(236,72,153,.5)' }} />
      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 14, padding: 24 }}>
        <span style={{ fontWeight: 800, letterSpacing: 4, fontSize: 13, background: neon, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{brand}</span>
        <h1 style={{ margin: 0, fontSize: 52, lineHeight: 1, fontWeight: 800, letterSpacing: -1, background: neon, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', filter: 'drop-shadow(0 0 18px rgba(168,85,247,.5))' }}>{headline}</h1>
        <p style={{ maxWidth: 420, margin: 0, fontSize: 15, color: '#c7c1ee' }}>{sub}</p>
        <button style={{ marginTop: 6, border: 'none', cursor: 'pointer', padding: '12px 24px', borderRadius: 12, fontWeight: 700, color: '#0b0420', background: neon, boxShadow: '0 0 22px rgba(168,85,247,.6)' }}>{cta}</button>
      </div>
    </div>
  );
}
