// A titled KPI card. Props (the `data` you place it with): { label, value, delta? }.
// A reusable leaf component — other components (e.g. Dashboard) import and compose it.
//
// This is the worked example the chat agent is pointed at ("read KpiCard first to match
// conventions", server/agent.ts), so it must model the design system rather than just work:
// colors come from the cedar tokens in src/styles.css (DESIGN.md is normative), NEVER
// hardcoded hex. The pad surface is dark (`--surface` is oklch(0.21 …), `color-scheme: dark`)
// — this card previously painted slate-900 text on it and was effectively invisible (#251).
export default function KpiCard({
  label = 'Metric',
  value = '—',
  delta,
}: {
  label?: string;
  value?: string | number;
  delta?: string;
}) {
  const up = typeof delta === 'string' && delta.trim().startsWith('+');
  return (
    <div style={{ padding: 16, font: '13px ui-sans-serif, system-ui' }}>
      <div style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--text)', marginTop: 4 }}>{value}</div>
      {delta != null && (
        <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: up ? 'var(--success)' : 'var(--danger)' }}>
          {delta}
        </div>
      )}
    </div>
  );
}
