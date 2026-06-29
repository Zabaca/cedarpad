// A bold synthwave / retro-arcade landing page. Props let you re-skin the copy.
export default function FredrinLanding({
  brand = 'FREDRIN',
  kicker = 'NOW IN OPEN BETA',
  headline = 'Ship at\narcade speed.',
  sub = 'The fastest way to go from idea to live. Built for builders who refuse to wait for the loading screen.',
  cta = 'Insert coin →',
  secondary = 'Watch the demo',
  nav = ['Product', 'Pricing', 'Docs'],
  stats = [
    { k: '12ms', v: 'cold start' },
    { k: '99.99%', v: 'uptime' },
    { k: '∞', v: 'lives' },
  ],
}: {
  brand?: string;
  kicker?: string;
  headline?: string;
  sub?: string;
  cta?: string;
  secondary?: string;
  nav?: string[];
  stats?: Array<{ k: string; v: string }>;
}) {
  const neon = 'linear-gradient(92deg,#22d3ee 0%,#a855f7 45%,#ec4899 100%)';
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'radial-gradient(120% 90% at 50% 8%, #2b0b4a 0%, #160a32 45%, #08040f 100%)',
        fontFamily: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
        color: '#e9e7ff',
      }}
    >
      <style>{`
        @keyframes fr-pulse { 0%,100%{filter:drop-shadow(0 0 14px rgba(168,85,247,.55)) drop-shadow(0 0 36px rgba(236,72,153,.35))} 50%{filter:drop-shadow(0 0 22px rgba(34,211,238,.65)) drop-shadow(0 0 54px rgba(168,85,247,.45))} }
        @keyframes fr-scan { from{transform:translateY(0)} to{transform:translateY(34px)} }
      `}</style>

      {/* retro sun */}
      <svg viewBox="0 0 200 200" style={{ position: 'absolute', top: 28, left: '50%', width: 230, height: 230, transform: 'translateX(-50%)', opacity: 0.92 }}>
        <defs>
          <linearGradient id="frSun" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffd36e" />
            <stop offset="55%" stopColor="#ff7ac6" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
          <clipPath id="frClip"><circle cx="100" cy="100" r="84" /></clipPath>
        </defs>
        <circle cx="100" cy="100" r="84" fill="url(#frSun)" />
        <g clipPath="url(#frClip)" fill="#160a32">
          {[110, 124, 140, 158, 178].map((y, i) => (
            <rect key={i} x="12" y={y} width="176" height={3 + i * 1.6} />
          ))}
        </g>
      </svg>

      {/* perspective grid floor */}
      <svg viewBox="0 0 800 240" preserveAspectRatio="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: '46%', opacity: 0.55 }}>
        <defs>
          <linearGradient id="frGrid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <g stroke="url(#frGrid)" strokeWidth="1.5" fill="none">
          {Array.from({ length: 13 }).map((_, i) => (
            <line key={`v${i}`} x1={400 + (i - 6) * 26} y1="10" x2={400 + (i - 6) * 150} y2="240" />
          ))}
          {[20, 48, 86, 138, 210].map((y, i) => (
            <line key={`h${i}`} x1="0" y1={y} x2="800" y2={y} />
          ))}
        </g>
      </svg>

      {/* scanline shimmer */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'repeating-linear-gradient(180deg,rgba(255,255,255,0.035) 0 1px,transparent 1px 4px)', animation: 'fr-scan 1.6s linear infinite', mixBlendMode: 'overlay' }} />

      {/* content */}
      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', padding: '20px 30px' }}>
        <nav style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 800, letterSpacing: 3, fontSize: 16, background: neon, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{brand}</span>
          <div style={{ display: 'flex', gap: 22, fontSize: 13, color: '#b9b2e6' }}>
            {nav.map((n) => (
              <span key={n} style={{ cursor: 'pointer' }}>{n}</span>
            ))}
            <span style={{ padding: '4px 12px', borderRadius: 999, border: '1px solid #ec4899', color: '#ffd6ef' }}>Sign in</span>
          </div>
        </nav>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 16 }}>
          <span style={{ fontSize: 11, letterSpacing: 4, color: '#7af0ff', textShadow: '0 0 10px rgba(34,211,238,.7)' }}>{kicker}</span>
          <h1
            style={{
              margin: 0,
              fontSize: 60,
              lineHeight: 0.96,
              fontWeight: 800,
              letterSpacing: -1,
              whiteSpace: 'pre-line',
              background: neon,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              animation: 'fr-pulse 3.4s ease-in-out infinite',
            }}
          >
            {headline}
          </h1>
          <p style={{ maxWidth: 440, margin: 0, fontSize: 14.5, lineHeight: 1.55, color: '#c7c1ee' }}>{sub}</p>
          <div style={{ display: 'flex', gap: 14, marginTop: 6, alignItems: 'center' }}>
            <button
              style={{
                border: 'none',
                cursor: 'pointer',
                padding: '12px 22px',
                borderRadius: 12,
                fontWeight: 700,
                fontSize: 14.5,
                color: '#0b0420',
                background: neon,
                boxShadow: '0 0 22px rgba(168,85,247,.6), 0 0 6px rgba(236,72,153,.8)',
              }}
            >
              {cta}
            </button>
            <button style={{ background: 'transparent', cursor: 'pointer', border: '1px solid rgba(122,240,255,.5)', color: '#bff4ff', padding: '12px 20px', borderRadius: 12, fontSize: 14 }}>
              ▷ {secondary}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 40, paddingBottom: 4 }}>
          {stats.map((s) => (
            <div key={s.v} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', textShadow: '0 0 14px rgba(236,72,153,.6)' }}>{s.k}</div>
              <div style={{ fontSize: 10.5, letterSpacing: 2, color: '#9b93cf', textTransform: 'uppercase' }}>{s.v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
