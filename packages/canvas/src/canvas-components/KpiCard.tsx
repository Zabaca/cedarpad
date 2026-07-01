// A titled KPI card. Props (the `data` you place it with): { label, value, delta? }.
// A reusable leaf component — other components (e.g. Dashboard) import and compose it.
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
      <div style={{ color: '#64748b', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: '#0f172a', marginTop: 4 }}>{value}</div>
      {delta != null && (
        <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: up ? '#16a34a' : '#dc2626' }}>{delta}</div>
      )}
    </div>
  );
}
