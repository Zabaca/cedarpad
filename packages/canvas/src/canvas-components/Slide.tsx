// One slide of a presentation deck. Props: { kind, eyebrow, title, subtitle, stats, chart, timeline, grid, footer }.
// kind selects the body layout: 'title' | 'stats' | 'chart' | 'timeline' | 'grid'.
const PALETTE = ['#6366f1', '#0ea5e9', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6', '#f43f5e'];

/** The deck's own bars, inlined when the platform `BarChart` was dropped in favour of
 *  `ChartCard` (Flint). It is NOT a reusable chart and deliberately isn't one: a slide paints
 *  its own LIGHT surface, so it cannot share a component that draws with the pad's dark cedar
 *  tokens — `var(--text)` labels on this white card rendered near-invisible. Colors here are
 *  literal and internally consistent with the rest of Slide, which is the documented exception
 *  to the token rule. Anything wanting a real chart should place `ChartCard`. */
function Bars({ bars, height }: { bars: Array<{ label: string; value: number; color?: string }>; height: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height, padding: '0 8px' }}>
      {bars.map((b, i) => (
        <div
          key={i}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, height: '100%', justifyContent: 'flex-end' }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>{b.value}</div>
          <div
            style={{
              width: '100%',
              maxWidth: 44,
              height: `${Math.max(4, (b.value / max) * (height - 40))}px`,
              background: b.color || PALETTE[i % PALETTE.length],
              borderRadius: '6px 6px 0 0',
            }}
          />
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 6, textAlign: 'center' }}>{b.label}</div>
        </div>
      ))}
    </div>
  );
}

export default function Slide({
  kind = 'title',
  eyebrow = '',
  title = 'Untitled slide',
  subtitle = '',
  stats = [],
  chart = null,
  timeline = [],
  grid = [],
  footer = '',
}: {
  kind?: 'title' | 'stats' | 'chart' | 'timeline' | 'grid';
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  stats?: Array<{ label: string; value: string | number }>;
  chart?: { bars: Array<{ label: string; value: number; color?: string }> } | null;
  timeline?: Array<{ date: string; items: string[] }>;
  grid?: Array<{ title: string; desc: string; tag?: string }>;
  footer?: string;
}) {
  return (
    <div
      style={{
        width: 900,
        height: 560,
        background: '#ffffff',
        borderRadius: 16,
        boxShadow: '0 1px 3px rgba(15,23,42,0.08)',
        border: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        font: '13px ui-sans-serif, system-ui',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '32px 40px 20px' }}>
        {eyebrow && (
          <div style={{ color: '#6366f1', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
            {eyebrow}
          </div>
        )}
        <div style={{ fontSize: kind === 'title' ? 40 : 26, fontWeight: 800, color: '#0f172a', marginTop: 8, lineHeight: 1.15 }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 15, color: '#64748b', marginTop: 10, lineHeight: 1.5 }}>{subtitle}</div>
        )}
      </div>

      <div style={{ flex: 1, padding: '0 40px 32px', overflow: 'auto' }}>
        {kind === 'stats' && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(stats.length || 1, 4)}, 1fr)`, gap: 16, marginTop: 12 }}>
            {stats.map((s, i) => (
              <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px 16px', background: '#f8fafc' }}>
                <div style={{ fontSize: 32, fontWeight: 800, color: '#0f172a' }}>{s.value}</div>
                <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {kind === 'chart' && chart && (
          <div style={{ marginTop: 8 }}>
            <Bars bars={chart.bars} height={260} />
          </div>
        )}

        {kind === 'timeline' && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {timeline.map((day, i) => (
              <div key={i} style={{ display: 'flex', gap: 16 }}>
                <div style={{ width: 92, flexShrink: 0, fontWeight: 700, color: '#0f172a', fontSize: 13, paddingTop: 2 }}>
                  {day.date}
                </div>
                <div style={{ flex: 1, borderLeft: '2px solid #e2e8f0', paddingLeft: 16 }}>
                  {day.items.map((it, j) => (
                    <div key={j} style={{ fontSize: 13.5, color: '#334155', marginBottom: 6, lineHeight: 1.4 }}>
                      {it}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {kind === 'grid' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginTop: 8 }}>
            {grid.map((g, i) => (
              <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
                {g.tag && (
                  <div
                    style={{
                      display: 'inline-block',
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: '#fff',
                      background: PALETTE[i % PALETTE.length],
                      borderRadius: 999,
                      padding: '2px 9px',
                      marginBottom: 8,
                      textTransform: 'uppercase',
                      letterSpacing: 0.4,
                    }}
                  >
                    {g.tag}
                  </div>
                )}
                <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14.5 }}>{g.title}</div>
                <div style={{ color: '#64748b', fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>{g.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {footer && (
        <div style={{ padding: '14px 40px', borderTop: '1px solid #f1f5f9', color: '#94a3b8', fontSize: 12 }}>
          {footer}
        </div>
      )}
    </div>
  );
}
