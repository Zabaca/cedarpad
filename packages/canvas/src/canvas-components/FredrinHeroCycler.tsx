// Cycle through hero variations for Fredrin. Composes the FredrinHero* components
// and flips between them with the same copy, so you can compare styles. Edit a
// variation file to refine it; this reloads. Edit the `variations` list to add one.
import { useState } from 'react';
import FredrinHeroSynth, { type HeroProps } from './FredrinHeroSynth';
import FredrinHeroMinimal from './FredrinHeroMinimal';
import FredrinHeroTerminal from './FredrinHeroTerminal';
import FredrinHeroBold from './FredrinHeroBold';

const variations: Array<{ name: string; C: (p: HeroProps) => JSX.Element }> = [
  { name: 'Synthwave', C: FredrinHeroSynth },
  { name: 'Editorial', C: FredrinHeroMinimal },
  { name: 'Terminal', C: FredrinHeroTerminal },
  { name: 'Brutalist', C: FredrinHeroBold },
];

export default function FredrinHeroCycler(content: HeroProps) {
  const [i, setI] = useState(0);
  const v = variations[((i % variations.length) + variations.length) % variations.length]!;
  const Hero = v.C;
  const go = (d: number) => setI((x) => x + d);

  const btn: React.CSSProperties = {
    cursor: 'pointer',
    width: 30,
    height: 30,
    borderRadius: 8,
    border: '1px solid #2b3344',
    background: '#11161f',
    color: '#e6e9ef',
    fontSize: 15,
    lineHeight: 1,
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1017', fontFamily: 'ui-sans-serif, system-ui' }}>
      {/* control bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid #1c2230', color: '#e6e9ef' }}>
        <button style={btn} onClick={() => go(-1)} title="Previous">
          ‹
        </button>
        <button style={btn} onClick={() => go(1)} title="Next">
          ›
        </button>
        <div style={{ marginLeft: 6, fontWeight: 600, fontSize: 13 }}>
          {v.name}
          <span style={{ color: '#8b93a3', fontWeight: 400 }}> · hero {(((i % variations.length) + variations.length) % variations.length) + 1}/{variations.length}</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {variations.map((vr, idx) => {
            const active = (((i % variations.length) + variations.length) % variations.length) === idx;
            return (
              <button
                key={vr.name}
                onClick={() => setI(idx)}
                title={vr.name}
                style={{ cursor: 'pointer', border: 'none', padding: 0, width: active ? 22 : 8, height: 8, borderRadius: 999, background: active ? '#4f7cff' : '#2b3344', transition: 'width .15s' }}
              />
            );
          })}
        </div>
      </div>
      {/* preview */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Hero {...content} />
      </div>
    </div>
  );
}
