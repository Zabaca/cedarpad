// Illustration: a Ticket entering the Fredrin system. The unit of work you write;
// each one spawns its own AI agent on an isolated branch. Styled on fredrin's warm
// cream + dark-card look. Shared FredrinPalette keeps the three illustrations on-brand.
export const FRED = {
  cream: '#e9e7de',
  ink: '#1a1a1a',
  panel: '#0e1014',
  panelEdge: '#1d212b',
  sub: '#8b93a3',
  blue: '#5f6f8c',
  rust: '#b06049',
  olive: '#8b8a4d',
  green: '#3fb950',
  greenBg: '#15311d',
  purple: '#a78bfa',
};

export interface TicketProps {
  id?: string;
  title?: string;
  status?: string;
  weight?: string;
}

export default function FredrinTicket({
  id = 'XIVUZO',
  title = 'Add stop button to halt ongoing chat responses',
  status = 'queued',
  weight = '674',
}: TicketProps) {
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: FRED.cream, fontFamily: 'ui-sans-serif, system-ui', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 18 }}>
      <div style={{ fontSize: 11, letterSpacing: 3, fontWeight: 700, color: '#9a958a' }}>① TICKET IN</div>

      {/* the ticket card */}
      <div style={{ width: 320, background: FRED.panel, border: `1px solid ${FRED.panelEdge}`, borderRadius: 14, padding: 18, color: '#e6e9ef', boxShadow: '0 18px 40px rgba(20,18,12,0.22)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: FRED.rust }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: FRED.sub }}>{status.toUpperCase()}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', color: FRED.sub }}>{id}</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 12, color: FRED.sub }}>
          <span style={{ display: 'inline-flex', gap: 2 }}>
            <span style={{ width: 3, height: 10, background: FRED.olive, borderRadius: 1 }} />
            <span style={{ width: 3, height: 14, background: FRED.olive, borderRadius: 1 }} />
            <span style={{ width: 3, height: 7, background: '#3a3f4a', borderRadius: 1 }} />
          </span>
          <span>{weight} tok</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 12 }}>⌥</span> isolated branch
          </span>
        </div>
      </div>

      <div style={{ color: FRED.sub, fontSize: 22, lineHeight: 1 }}>↓</div>
      <div style={{ fontSize: 13, color: '#5c574d', maxWidth: 300, textAlign: 'center', lineHeight: 1.45 }}>
        You write it like a Linear card. Fredrin spins up an agent on its own branch to build it.
      </div>
    </div>
  );
}
