// Illustration: a Claude Code Session running the ticket on its own branch.
// Live activity feed: the agent reads, edits, runs tests, all inside an isolated
// worktree. Imports the shared FredrinPalette from the Ticket illustration.
import { FRED } from './FredrinTicket';

export interface SessionProps {
  branch?: string;
  ticket?: string;
}

const STEPS: Array<{ k: string; t: string; tone?: 'run' | 'ok' }> = [
  { k: 'read', t: 'Read  ChatStream.tsx · agent.ts' },
  { k: 'edit', t: 'Edit  add abort signal + stop control' },
  { k: 'bash', t: 'Run   bun test  ·  28 passing', tone: 'ok' },
  { k: 'work', t: 'Verify  rendering stop button…', tone: 'run' },
];

export default function FredrinSession({
  branch = 'fredrin/xivuzo-stop-button',
  ticket = 'XIVUZO',
}: SessionProps) {
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: FRED.cream, fontFamily: 'ui-sans-serif, system-ui', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 18 }}>
      <div style={{ fontSize: 11, letterSpacing: 3, fontWeight: 700, color: '#9a958a' }}>② CLAUDE CODE SESSION</div>

      <div style={{ width: 360, background: FRED.panel, border: `1px solid ${FRED.panelEdge}`, borderRadius: 14, overflow: 'hidden', color: '#e6e9ef', boxShadow: '0 18px 40px rgba(20,18,12,0.22)' }}>
        {/* window chrome */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: `1px solid ${FRED.panelEdge}`, fontFamily: mono, fontSize: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f56' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#27c93f' }} />
          <span style={{ marginLeft: 6, color: FRED.purple }}>⎇ {branch}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: FRED.green }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: FRED.green, animation: 'fpulse 1.2s ease-in-out infinite' }} />
            running
          </span>
        </div>
        <style>{'@keyframes fpulse{0%,100%{opacity:1}50%{opacity:.25}}'}</style>

        {/* activity feed */}
        <div style={{ padding: '14px 16px', fontFamily: mono, fontSize: 12.5, lineHeight: 1.4, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {STEPS.map((s) => {
            const dot = s.tone === 'ok' ? FRED.green : s.tone === 'run' ? FRED.olive : FRED.sub;
            const key = s.tone === 'ok' ? FRED.green : '#58a6ff';
            const [verb, ...rest] = s.t.split(/\s{2,}/);
            return (
              <div key={s.k} style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flex: '0 0 auto', transform: 'translateY(-1px)', animation: s.tone === 'run' ? 'fpulse 1.1s ease-in-out infinite' : undefined }} />
                <span style={{ color: key, minWidth: 46 }}>{verb}</span>
                <span style={{ color: s.tone === 'run' ? '#e6e9ef' : '#aeb6c2' }}>{rest.join('  ')}{s.tone === 'run' && <span style={{ color: FRED.olive }}> ▋</span>}</span>
              </div>
            );
          })}
        </div>
        <div style={{ padding: '10px 16px', borderTop: `1px solid ${FRED.panelEdge}`, fontSize: 11, color: FRED.sub, display: 'flex', gap: 14 }}>
          <span>ticket {ticket}</span>
          <span>·</span>
          <span>9 of 10 agents free</span>
          <span style={{ marginLeft: 'auto' }}>no merge to main yet</span>
        </div>
      </div>

      <div style={{ color: FRED.sub, fontSize: 22, lineHeight: 1 }}>↓</div>
      <div style={{ fontSize: 13, color: '#5c574d', maxWidth: 320, textAlign: 'center', lineHeight: 1.45 }}>
        The agent works the ticket end to end in its own sandbox. Run ten at once, nothing touches main.
      </div>
    </div>
  );
}
