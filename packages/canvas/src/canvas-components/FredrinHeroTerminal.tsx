// Hero variation: terminal / developer aesthetic. Mono, dark, faux shell window.
import type { HeroProps } from './FredrinHeroSynth';

export default function FredrinHeroTerminal({
  brand = 'fredrin',
  headline = 'Ship at arcade speed.',
  sub = 'From idea to live before the loading screen finishes.',
  cta = 'run init',
}: HeroProps) {
  const mono = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <div style={{ width: '100%', height: '100%', background: '#0a0e14', color: '#c9d1d9', fontFamily: mono, display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid #1c2230', fontSize: 12, color: '#6e7681' }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f56' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#ffbd2e' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#27c93f' }} />
        <span style={{ marginLeft: 8 }}>{brand} — zsh</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '24px 30px', gap: 10 }}>
        <div style={{ fontSize: 13, color: '#56d364' }}>
          <span style={{ color: '#58a6ff' }}>~/fredrin</span> $ {brand} --start
        </div>
        <h1 style={{ margin: '6px 0', fontSize: 40, lineHeight: 1.05, fontWeight: 700, color: '#f0f6fc', letterSpacing: -0.5 }}>
          {headline}
          <span style={{ display: 'inline-block', width: 14, height: 34, marginLeft: 6, background: '#56d364', verticalAlign: '-4px', animation: 'blink 1s steps(1) infinite' }} />
        </h1>
        <style>{'@keyframes blink{50%{opacity:0}}'}</style>
        <p style={{ margin: 0, fontSize: 14, color: '#8b949e', maxWidth: 460, lineHeight: 1.55 }}>
          <span style={{ color: '#6e7681' }}>// </span>
          {sub}
        </p>
        <div style={{ marginTop: 10 }}>
          <button style={{ cursor: 'pointer', fontFamily: mono, background: 'transparent', color: '#56d364', border: '1px solid #2ea043', padding: '10px 18px', borderRadius: 6, fontSize: 13.5 }}>$ {cta}</button>
        </div>
      </div>
    </div>
  );
}
