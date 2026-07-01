// Hero variation: editorial / minimal. Light, generous whitespace, serif display.
import type { HeroProps } from './FredrinHeroSynth';

export default function FredrinHeroMinimal({
  brand = 'Fredrin',
  headline = 'Ship at arcade speed.',
  sub = 'From idea to live before the loading screen finishes.',
  cta = 'Get started',
}: HeroProps) {
  return (
    <div style={{ width: '100%', height: '100%', background: '#f7f5f0', color: '#15130f', fontFamily: 'Georgia, "Times New Roman", serif', display: 'flex', flexDirection: 'column', padding: '30px 44px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'ui-sans-serif,system-ui' }}>
        <span style={{ fontWeight: 700, letterSpacing: 1, fontSize: 15 }}>{brand}</span>
        <span style={{ fontSize: 12, letterSpacing: 2, color: '#9a958a' }}>EST. 2026</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', maxWidth: 560 }}>
        <span style={{ fontFamily: 'ui-sans-serif,system-ui', fontSize: 11, letterSpacing: 3, color: '#b08968', marginBottom: 14 }}>A QUIETER KIND OF FAST</span>
        <h1 style={{ margin: 0, fontSize: 56, lineHeight: 1.02, fontWeight: 400, letterSpacing: -1 }}>{headline}</h1>
        <p style={{ marginTop: 18, fontSize: 17, lineHeight: 1.5, color: '#5c574d', maxWidth: 440 }}>{sub}</p>
        <div style={{ marginTop: 26, fontFamily: 'ui-sans-serif,system-ui' }}>
          <button style={{ cursor: 'pointer', background: '#15130f', color: '#f7f5f0', border: 'none', padding: '13px 26px', borderRadius: 2, fontSize: 14, letterSpacing: 0.5 }}>{cta}</button>
          <span style={{ marginLeft: 18, fontSize: 14, color: '#7a756a', borderBottom: '1px solid #c9c3b6', paddingBottom: 2, cursor: 'pointer' }}>Read the story →</span>
        </div>
      </div>
    </div>
  );
}
