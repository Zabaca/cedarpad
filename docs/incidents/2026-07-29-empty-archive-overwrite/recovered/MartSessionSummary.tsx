// Live summary of the `mart_session_events` mart (ADR-0017). Place it with
// dataSource: { kind: 'mart', name: 'mart_session_events' } — the host resolves the mart
// and passes `rows` (JSON-safe, BigInt/Date already coerced) plus `mart` (the sidecar).
// Colors come from the cedar tokens: this draws on the pad's own dark surface, so a
// hardcoded hex text color would be invisible (#251).
export default function MartSessionSummary({
  rows = [],
  mart,
}: {
  rows?: Array<Record<string, string | number | boolean | null>>;
  mart?: { name: string; generatedAt: string; rowCount: number };
}) {
  if (!rows.length) {
    return (
      <div style={{ padding: 18, font: '13px ui-sans-serif, system-ui', color: 'var(--muted)' }}>
        no mart rows resolved — is a dataSource set?
      </div>
    );
  }
  const num = (r: Record<string, unknown>, k: string) => Number(r[k] ?? 0);
  const out = rows.reduce((a, r) => a + num(r, 'output_tokens'), 0);
  const inp = rows.reduce((a, r) => a + num(r, 'input_tokens'), 0);
  const cacheRead = rows.reduce((a, r) => a + num(r, 'cache_read_input_tokens'), 0);
  const sessions = new Set(rows.map((r) => String(r.session_id))).size;
  const models = [...new Set(rows.map((r) => String(r.model)))].filter((m) => m && m !== 'null');

  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ color: 'var(--text)', fontSize: 24, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 18, font: '13px ui-sans-serif, system-ui', height: '100%', overflow: 'auto' }}>
      <div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {mart?.name ?? 'mart'} · live
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 16, marginTop: 14 }}>
        <Stat label="assistant turns" value={rows.length.toLocaleString()} />
        <Stat label="sessions" value={sessions.toLocaleString()} />
        <Stat label="output tokens" value={out.toLocaleString()} />
        <Stat label="input tokens" value={inp.toLocaleString()} />
        <Stat label="cache reads" value={cacheRead.toLocaleString()} />
      </div>
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line)', color: 'var(--faint)', fontSize: 11 }}>
        models: {models.join(', ') || '—'}
      </div>
    </div>
  );
}
