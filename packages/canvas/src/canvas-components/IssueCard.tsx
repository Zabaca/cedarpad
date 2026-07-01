// A canvas card that renders a tracked issue (markdown-lite) for design/eng backlog.
// Props: {
//   title: string, status?: string, filed?: string, tags?: string[],
//   sections: Array<{ heading: string, body?: string, items?: string[], code?: boolean }>
// }
// `body` supports inline `code` spans via backticks. `items` renders a bullet list.

interface Section {
  heading: string;
  body?: string;
  items?: string[];
  code?: boolean;
}
interface Props {
  title?: string;
  status?: string;
  filed?: string;
  tags?: string[];
  sections?: Section[];
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// render a string with `backtick` spans turned into inline code
function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} style={{ fontFamily: mono, fontSize: 11.5, background: '#eef2f7',
            color: '#0f172a', padding: '1px 5px', borderRadius: 5 }}>{p.slice(1, -1)}</code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

const statusColor: Record<string, string> = {
  open: '#16a34a', backlog: '#64748b', 'in progress': '#d97706',
  blocked: '#dc2626', done: '#7c3aed',
};

export default function IssueCard({
  title = 'Untitled issue',
  status = 'open',
  filed = '',
  tags = [],
  sections = [],
}: Props) {
  const sc = statusColor[status.toLowerCase()] ?? '#64748b';
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui',
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, overflow: 'hidden',
      boxShadow: '0 4px 18px rgba(15,23,42,0.08)' }}>
      {/* header */}
      <div style={{ flexShrink: 0, padding: '14px 18px 12px', borderBottom: '1px solid #eef2f7',
        background: 'linear-gradient(180deg,#fbfbfd,#f6f8fb)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
            fontWeight: 700, color: '#fff', background: sc, padding: '2px 9px', borderRadius: 20,
            textTransform: 'uppercase', letterSpacing: 0.4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />{status}
          </span>
          {filed && <span style={{ fontSize: 11, color: '#94a3b8' }}>filed {filed}</span>}
          {tags.map((t) => (
            <span key={t} style={{ fontSize: 10.5, fontWeight: 600, color: '#475569',
              background: '#eef2f7', padding: '2px 8px', borderRadius: 6 }}>{t}</span>
          ))}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', lineHeight: 1.25 }}>{title}</div>
      </div>
      {/* body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 18px 16px' }}>
        {sections.map((s, i) => (
          <div key={i} style={{ marginTop: 14 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
              color: '#94a3b8', marginBottom: 6 }}>{s.heading}</div>
            {s.body && (
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#334155',
                fontFamily: s.code ? mono : 'system-ui',
                background: s.code ? '#0f172a' : 'transparent',
                ...(s.code ? { color: '#e2e8f0', padding: '10px 12px', borderRadius: 9, fontSize: 11.5, whiteSpace: 'pre-wrap' } : {}) }}>
                <RichText text={s.body} />
              </div>
            )}
            {s.items && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {s.items.map((it, j) => (
                  <li key={j} style={{ fontSize: 12.5, lineHeight: 1.55, color: '#334155', marginBottom: 3 }}>
                    <RichText text={it} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
