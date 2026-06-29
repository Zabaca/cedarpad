import * as React from 'react';

const C = {
  bg: '#0d0f14',
  panel: '#11141a',
  border: '#2a2e3d',
  text: '#c9cdd6',
  dim: '#555e72',
  blue: '#4a9eff',
  purple: '#a78bfa',
  green: '#34d399',
  orange: '#fb923c',
  pink: '#f472b6',
  yellow: '#fbbf24',
};

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      background: color + '22',
      border: `1px solid ${color}55`,
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 11,
      color,
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>{label}</div>
  );
}

function Arrow({ color = C.dim, vertical = false }: { color?: string; vertical?: boolean }) {
  if (vertical) return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0' }}>
      <svg width="14" height="20" viewBox="0 0 14 20">
        <line x1="7" y1="0" x2="7" y2="14" stroke={color} strokeWidth="1.5"/>
        <polygon points="7,20 3,12 11,12" fill={color}/>
      </svg>
    </div>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', margin: '0 4px' }}>
      <svg width="24" height="14" viewBox="0 0 24 14">
        <line x1="0" y1="7" x2="18" y2="7" stroke={color} strokeWidth="1.5"/>
        <polygon points="24,7 16,3 16,11" fill={color}/>
      </svg>
    </div>
  );
}

function InputNode({ label, sublabel, color }: { label: string; sublabel: string; color: string }) {
  return (
    <div style={{
      background: color + '18',
      border: `1px solid ${color}44`,
      borderRadius: 8,
      padding: '8px 10px',
      marginBottom: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color }}>{label}</div>
      <div style={{ fontSize: 10, color: C.dim }}>{sublabel}</div>
    </div>
  );
}

function TransformerBlock({ index, total }: { index: number; total: number }) {
  const isFirst = index === 0;
  const ops = [
    { label: 'Sparse Ref Attention', color: C.purple, tip: 'Identity lock from reference video tokens' },
    { label: 'Audio Cross-Attention', color: C.green, tip: 'Audio tokens drive lip/motion' },
    { label: 'Self-Attention', color: C.blue, tip: 'Global consistency across patches' },
    { label: 'FFN + AdaLN', color: C.orange, tip: 'Flow-step conditioning via adaptive layer norm' },
  ];
  return (
    <div style={{
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      background: '#161920',
      marginBottom: 4,
      overflow: 'hidden',
    }}>
      <div style={{
        background: '#1a1e29',
        padding: '4px 10px',
        fontSize: 10,
        fontWeight: 700,
        color: C.dim,
        letterSpacing: '0.05em',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>TRANSFORMER BLOCK {index + 1}</span>
        {isFirst && <span style={{ color: C.yellow }}>× {total} layers</span>}
      </div>
      <div style={{ padding: '6px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ops.map(op => (
          <div key={op.label} title={op.tip} style={{
            background: op.color + '18',
            border: `1px solid ${op.color}44`,
            borderRadius: 5,
            padding: '3px 7px',
            fontSize: 10,
            color: op.color,
            fontWeight: 600,
            cursor: 'default',
          }}>{op.label}</div>
        ))}
      </div>
    </div>
  );
}

function TrainingStage({ n, label, detail, color }: { n: number; label: string; detail: string; color: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: color + '22', border: `2px solid ${color}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 800, color,
      }}>{n}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color, textAlign: 'center', lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontSize: 9, color: C.dim, textAlign: 'center', lineHeight: 1.3 }}>{detail}</div>
    </div>
  );
}

export default function DiTArchitecture() {
  const [hoveredStage, setHoveredStage] = React.useState<number | null>(null);
  const stages = [
    { label: 'Text→Video Pretrain', detail: 'Internet-scale video; temporal consistency', color: C.blue },
    { label: 'Audio→Video Pretrain', detail: 'Adds audio cross-attention on talking heads', color: C.green },
    { label: 'Personality SFT', detail: 'Same-identity pairs + Sparse Ref Attention', color: C.purple },
    { label: 'CFG Distillation', detail: 'Multi-guidance → single forward pass', color: C.orange },
    { label: 'Distribution Match', detail: 'Identity fidelity + motion naturalness', color: C.pink },
  ];

  return (
    <div style={{
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: 14,
      color: C.text,
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      fontSize: 12,
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      overflow: 'auto',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${C.border}`, paddingBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.pink, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          HeyGen DiT — Built From Scratch
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Tag label="Flow Matching" color={C.yellow} />
          <Tag label="Proprietary Weights" color={C.orange} />
        </div>
      </div>

      {/* Main architecture row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flex: 1 }}>

        {/* Inputs column */}
        <div style={{ width: 140, flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inputs</div>
          <InputNode label="Reference Video" sublabel="15s clip → patch tokens" color={C.purple} />
          <InputNode label="Audio Track" sublabel="LLM tokenizer → discrete tokens" color={C.green} />
          <InputNode label="Gaussian Noise" sublabel="Flow matching start point" color={C.blue} />
          <InputNode label="Flow Step t" sublabel="AdaLN conditioning signal" color={C.orange} />
        </div>

        <Arrow color={C.border} />

        {/* Patchification */}
        <div style={{ flexShrink: 0, width: 90 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tokenize</div>
          <div style={{
            border: `1px dashed ${C.border}`,
            borderRadius: 8,
            padding: '8px 6px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            alignItems: 'center',
          }}>
            <div style={{ fontSize: 10, color: C.blue, fontWeight: 600, textAlign: 'center' }}>Patchify</div>
            <div style={{ fontSize: 9, color: C.dim, textAlign: 'center' }}>video frames → flat patch tokens</div>
            <div style={{ fontSize: 9, color: C.purple, textAlign: 'center', marginTop: 2 }}>+ ref video tokens</div>
          </div>
        </div>

        <Arrow color={C.border} />

        {/* Transformer stack */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>DiT Stack (L layers)</div>
          <TransformerBlock index={0} total={24} />
          <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0' }}>
            <div style={{ fontSize: 9, color: C.dim }}>· · ·</div>
          </div>
          <TransformerBlock index={23} total={24} />
        </div>

        <Arrow color={C.border} />

        {/* Output column */}
        <div style={{ width: 120, flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Output</div>
          <div style={{
            background: C.green + '15',
            border: `1px solid ${C.green}44`,
            borderRadius: 8,
            padding: '8px 8px',
            marginBottom: 6,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.green }}>Clean Latent</div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>denoised via flow ODE</div>
          </div>
          <Arrow vertical color={C.dim} />
          <div style={{
            background: C.pink + '15',
            border: `1px solid ${C.pink}44`,
            borderRadius: 8,
            padding: '8px 8px',
            marginBottom: 6,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.pink }}>ID-Aware SR</div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>super-resolution (shared DiT backbone)</div>
          </div>
          <Arrow vertical color={C.dim} />
          <div style={{
            background: C.yellow + '15',
            border: `1px solid ${C.yellow}44`,
            borderRadius: 8,
            padding: '8px 8px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.yellow }}>Final Video</div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>identity-locked, lip-synced</div>
          </div>
        </div>
      </div>

      {/* Why not U-Net callout */}
      <div style={{
        background: '#1a1e29',
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 11,
        color: C.dim,
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}>
        <span style={{ color: C.yellow, fontWeight: 800, flexShrink: 0 }}>Why DiT over U-Net?</span>
        <span>Everything is tokens. Reference video, audio, and noise all live in the same token space — so injecting them is architecturally clean (just attention). U-Net would require awkward skip-connection surgery at specific resolution levels. Flow matching also gives a smooth loss landscape that makes distillation (stages 4–5) tractable.</span>
      </div>

      {/* Training pipeline */}
      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>5-Stage Training Pipeline (from scratch)</div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
          {stages.map((s, i) => (
            <React.Fragment key={i}>
              <TrainingStage n={i + 1} label={s.label} detail={s.detail} color={s.color} />
              {i < stages.length - 1 && (
                <div style={{ paddingTop: 10, flexShrink: 0 }}>
                  <svg width="16" height="14" viewBox="0 0 16 14">
                    <line x1="0" y1="7" x2="10" y2="7" stroke={C.border} strokeWidth="1.5"/>
                    <polygon points="16,7 8,3 8,11" fill={C.border}/>
                  </svg>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
