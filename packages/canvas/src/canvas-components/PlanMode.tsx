import { useState } from 'react';

interface Step {
  text: string;
  detail?: string;
}

interface Props {
  title?: string;
  description?: string;
  steps?: Step[];
  // Injected by the component host, bound to the chat this card is attached to.
  sendToAgent: (message: string) => Promise<void>;
}

export default function PlanMode({
  title = 'Untitled Plan',
  description = '',
  steps = [],
  sendToAgent,
}: Props) {
  const [annotations, setAnnotations] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'pending' | 'submitting' | 'approved' | 'rejected'>('pending');
  const [error, setError] = useState('');

  const annotate = (i: number, val: string) =>
    setAnnotations(prev => ({ ...prev, [i]: val }));

  const submit = async (verdict: 'approved' | 'rejected') => {
    setStatus('submitting');
    const stepLines = steps
      .map((s, i) => {
        const note = annotations[i];
        return `  ${i + 1}. ${s.text}${note ? `\n     ↳ "${note}"` : ''}`;
      })
      .join('\n');

    const msg = [
      `[PLAN ${verdict.toUpperCase()}] ${title}`,
      description ? `\n${description}` : '',
      `\n\nSteps:\n${stepLines}`,
      notes ? `\n\nNotes: ${notes}` : '',
    ].join('');

    try {
      await sendToAgent(msg);
      setStatus(verdict);
    } catch (e: any) {
      setError(e.message);
      setStatus('pending');
    }
  };

  const approved = status === 'approved';
  const rejected = status === 'rejected';
  const done = approved || rejected;
  const submitting = status === 'submitting';

  if (done) {
    return (
      <div style={{ fontFamily: 'system-ui', height: '100%', background: approved ? '#f0fdf4' : '#fff1f2', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>{approved ? '✅' : '❌'}</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: approved ? '#15803d' : '#be123c' }}>
          Plan {approved ? 'Approved' : 'Rejected'}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.6, maxWidth: 280 }}>
          Your decision has been sent to the agent. It will respond in the chat.
        </div>
        <button
          onClick={() => { setStatus('pending'); setAnnotations({}); setNotes(''); setError(''); }}
          style={{ marginTop: 8, background: 'transparent', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 18px', fontSize: 11, color: '#6b7280', cursor: 'pointer' }}>
          Reset
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui', height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', background: '#fff' }}>

      {/* Header */}
      <div style={{ background: '#0f172a', padding: '18px 20px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ background: '#f59e0b', color: '#1c1917', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 4, letterSpacing: 1 }}>PLAN MODE</span>
          <span style={{ background: '#1e293b', color: '#64748b', fontSize: 9, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>AWAITING REVIEW</span>
        </div>
        <div style={{ fontWeight: 800, fontSize: 16, color: '#f8fafc', letterSpacing: '-0.5px' }}>{title}</div>
        {description && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 1.6 }}>{description}</div>}
      </div>

      {/* Steps */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#94a3b8', marginBottom: 14 }}>
          {steps.length} Step{steps.length !== 1 ? 's' : ''}
        </div>
        {steps.map((step, i) => (
          <div key={i} style={{ marginBottom: 16, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ background: '#0f172a', color: '#f8fafc', borderRadius: 6, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', lineHeight: 1.5 }}>{step.text}</div>
                {step.detail && <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, lineHeight: 1.5 }}>{step.detail}</div>}
              </div>
            </div>
            <div style={{ borderTop: '1px solid #e2e8f0', padding: '8px 14px' }}>
              <input
                value={annotations[i] || ''}
                onChange={e => annotate(i, e.target.value)}
                placeholder="Annotate this step…"
                style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 11, color: '#475569', outline: 'none', fontFamily: 'system-ui' }}
              />
            </div>
          </div>
        ))}

        {/* Overall notes */}
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#94a3b8', marginBottom: 8 }}>Overall notes</div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Any overall feedback for the agent…"
            rows={3}
            style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 11, color: '#475569', outline: 'none', resize: 'none', fontFamily: 'system-ui', lineHeight: 1.6 }}
          />
        </div>

        {error && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 12, padding: '8px 12px', background: '#fff1f2', borderRadius: 8 }}>Error: {error}</div>}
      </div>

      {/* Actions */}
      <div style={{ padding: '14px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 10, flexShrink: 0 }}>
        <button
          onClick={() => submit('rejected')}
          disabled={submitting}
          style={{ flex: 1, background: '#fff1f2', color: '#be123c', border: '1.5px solid #fecdd3', borderRadius: 8, padding: '11px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          {submitting ? '…' : '✕ Reject'}
        </button>
        <button
          onClick={() => submit('approved')}
          disabled={submitting}
          style={{ flex: 2, background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          {submitting ? 'Sending…' : '✓ Approve Plan'}
        </button>
      </div>

    </div>
  );
}