// Simple horizontal-axis bar chart, no deps. Props: { bars: [{ label, value, color? }], height?, maxValue? }.
// Text colors come from the cedar tokens (src/styles.css, DESIGN.md): this component draws on
// the pad's own surface rather than painting its own background, so hardcoded dark text was
// invisible against `--surface` (#251). Bar fills stay literal — they're data series, not chrome.
export default function BarChart({
  bars = [],
  height = 180,
  color = 'var(--accent)',
}: {
  bars?: Array<{ label: string; value: number; color?: string }>;
  height?: number;
  color?: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height, padding: '0 8px' }}>
      {bars.map((b, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, height: '100%', justifyContent: 'flex-end' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{b.value}</div>
          <div
            style={{
              width: '100%',
              maxWidth: 44,
              height: `${Math.max(4, (b.value / max) * (height - 40))}px`,
              background: b.color || color,
              borderRadius: '6px 6px 0 0',
            }}
          />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>{b.label}</div>
        </div>
      ))}
    </div>
  );
}
