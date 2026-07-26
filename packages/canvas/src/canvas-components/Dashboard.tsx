// Composition example: Dashboard imports and lays out KpiCard.
// Props: { title, kpis: [{ label, value, delta? }] }.
import KpiCard from './KpiCard';

export default function Dashboard({
  title = 'Dashboard',
  kpis = [],
}: {
  title?: string;
  kpis?: Array<{ label: string; value: string | number; delta?: string }>;
}) {
  return (
    <div style={{ padding: 16, font: '13px ui-sans-serif, system-ui' }}>
      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 12 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
        {kpis.map((k, i) => (
          <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 10 }}>
            <KpiCard {...k} />
          </div>
        ))}
      </div>
    </div>
  );
}
