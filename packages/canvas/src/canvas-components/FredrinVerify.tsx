// Illustration: Visual Verification Artifacts. Before the PR is offered for merge,
// the agent captures proof it works: a checklist plus before/after screenshots.
// This is the "verified 2/2" badge on the kanban card, expanded. Shares FredrinPalette.
import { FRED } from './FredrinTicket';

export interface VerifyProps {
  passed?: number;
  total?: number;
  ticket?: string;
}

export default function FredrinVerify({ passed = 2, total = 2, ticket = 'XIVUZO' }: VerifyProps) {
  const allGood = passed >= total;
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', background: FRED.cream, fontFamily: 'ui-sans-serif, system-ui', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 18 }}>
      <div style={{ fontSize: 11, letterSpacing: 3, fontWeight: 700, color: '#9a958a' }}>③ VISUAL VERIFICATION</div>

      <div style={{ width: 360, background: FRED.panel, border: `1px solid ${FRED.panelEdge}`, borderRadius: 14, overflow: 'hidden', color: '#e6e9ef', boxShadow: '0 18px 40px rgba(20,18,12,0.22)' }}>
        {/* verified header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${FRED.panelEdge}` }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: FRED.greenBg, color: FRED.green, fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999 }}>
            ✓ verified {passed}/{total}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#241a3a', color: FRED.purple, fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999 }}>
            ⎇ PR ready
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', color: FRED.sub }}>{ticket}</span>
        </div>

        {/* before / after screenshots */}
        <div style={{ display: 'flex', gap: 10, padding: 16 }}>
          {[
            { label: 'before', ok: false },
            { label: 'after', ok: true },
          ].map((s) => (
            <div key={s.label} style={{ flex: 1, border: `1px solid ${s.ok ? '#27432e' : FRED.panelEdge}`, borderRadius: 9, overflow: 'hidden', background: '#0a0c10' }}>
              <div style={{ height: 78, background: 'linear-gradient(180deg,#171b22,#0c0f14)', position: 'relative', display: 'flex', alignItems: 'flex-end', padding: 8, gap: 5 }}>
                {/* fake chat bubbles */}
                <span style={{ position: 'absolute', top: 10, left: 8, width: 64, height: 9, borderRadius: 3, background: '#2b3140' }} />
                <span style={{ position: 'absolute', top: 24, left: 8, width: 44, height: 9, borderRadius: 3, background: '#222836' }} />
                {/* the stop button only in 'after' */}
                {s.ok ? (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, background: FRED.rust, color: '#fff', fontSize: 9, fontWeight: 700, padding: '4px 8px', borderRadius: 6 }}>
                    <span style={{ width: 7, height: 7, background: '#fff', borderRadius: 1 }} /> Stop
                  </span>
                ) : (
                  <span style={{ marginLeft: 'auto', width: 38, height: 18, borderRadius: 6, border: '1px dashed #3a3f4a' }} />
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', fontSize: 11, color: s.ok ? FRED.green : FRED.sub }}>
                {s.ok ? '✓' : '○'} {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* checks */}
        <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
          {['Stop button halts the stream mid-response', 'No regressions · 28 tests pass'].map((c) => (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#cdd3dc' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 17, height: 17, borderRadius: '50%', background: FRED.greenBg, color: FRED.green, fontSize: 11, flex: '0 0 auto' }}>✓</span>
              {c}
            </div>
          ))}
        </div>
      </div>

      <button style={{ cursor: 'pointer', border: 'none', background: allGood ? FRED.ink : '#3a3f4a', color: FRED.cream, fontWeight: 600, fontSize: 14, padding: '12px 26px', borderRadius: 999, fontFamily: 'inherit' }}>
        Review &amp; merge →
      </button>
    </div>
  );
}
