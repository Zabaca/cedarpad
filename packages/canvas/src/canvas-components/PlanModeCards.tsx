import { useState } from 'react';
import { sendToAgent } from '../agent-link';

type CardStatus = 'pending' | 'approved' | 'flagged';
interface Step { text: string; detail?: string; }
interface Props { title?: string; description?: string; steps?: Step[]; }

export default function PlanModeCards({ title = 'Plan', description = '', steps = [] }: Props) {
  const [cards, setCards] = useState<{ status: CardStatus; note: string }[]>(() => steps.map(() => ({ status: 'pending', note: '' })));
  const [overall, setOverall] = useState('');
  const [done, setDone] = useState<'approved'|'rejected'|null>(null);

  const setCard = (i: number, patch: Partial<{ status: CardStatus; note: string }>) =>
    setCards(p => p.map((c, j) => j === i ? { ...c, ...patch } : c));

  const submit = async (v: 'approved'|'rejected') => {
    setDone(v);
    const stepSummary = steps.map((s, i) => `  ${i+1}. [${cards[i].status.toUpperCase()}] ${s.text}${cards[i].note ? `\n     → ${cards[i].note}` : ''}`).join('\n');
    const msg = `[PLAN ${v.toUpperCase()}] ${title}\n\nSteps:\n${stepSummary}${overall ? `\n\nNotes: ${overall}` : ''}`;
    try { await sendToAgent(msg); } catch {}
  };

  if (done) return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', background: done==='approved'?'#f0fdf4':'#fff1f2', fontFamily:'system-ui', gap:12 }}>
      <div style={{ fontSize:36 }}>{done==='approved'?'✅':'❌'}</div>
      <div style={{ fontWeight:800, fontSize:16, color: done==='approved'?'#15803d':'#be123c' }}>Plan {done==='approved'?'Approved':'Rejected'}</div>
      <button onClick={()=>setDone(null)} style={{ marginTop:8, border:'1px solid #d1d5db', borderRadius:8, padding:'7px 16px', fontSize:11, cursor:'pointer', background:'#fff', color:'#6b7280' }}>Reset</button>
    </div>
  );

  const statusColors: Record<CardStatus, { bg: string; border: string; label: string }> = {
    pending: { bg: '#f8fafc', border: '#e2e8f0', label: '○ Pending' },
    approved: { bg: '#f0fdf4', border: '#86efac', label: '✓ Good' },
    flagged: { bg: '#fff7ed', border: '#fdba74', label: '⚑ Flagged' },
  };

  const flaggedCount = cards.filter(c => c.status === 'flagged').length;
  const approvedCount = cards.filter(c => c.status === 'approved').length;

  return (
    <div style={{ fontFamily:'system-ui', height:'100%', overflow:'hidden', display:'flex', flexDirection:'column', background:'#f8fafc' }}>

      {/* Header */}
      <div style={{ background:'#0f172a', padding:'14px 18px', flexShrink:0 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ display:'flex', gap:6, marginBottom:6 }}>
              <span style={{ background:'#f59e0b', color:'#1c1917', fontSize:9, fontWeight:800, padding:'2px 8px', borderRadius:4, letterSpacing:1 }}>PLAN MODE</span>
              {flaggedCount > 0 && <span style={{ background:'#ef4444', color:'#fff', fontSize:9, fontWeight:700, padding:'2px 8px', borderRadius:4 }}>{flaggedCount} flagged</span>}
              {approvedCount > 0 && <span style={{ background:'#22c55e', color:'#fff', fontSize:9, fontWeight:700, padding:'2px 8px', borderRadius:4 }}>{approvedCount}/{steps.length} ok</span>}
            </div>
            <div style={{ fontWeight:800, fontSize:15, color:'#f8fafc', letterSpacing:'-0.3px' }}>{title}</div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={()=>submit('rejected')} style={{ background:'rgba(239,68,68,0.15)', color:'#fca5a5', border:'1px solid rgba(239,68,68,0.3)', borderRadius:6, padding:'6px 12px', fontSize:11, fontWeight:700, cursor:'pointer' }}>✕</button>
            <button onClick={()=>submit('approved')} style={{ background:'#16a34a', color:'#fff', border:'none', borderRadius:6, padding:'6px 12px', fontSize:11, fontWeight:700, cursor:'pointer' }}>✓ Approve</button>
          </div>
        </div>
        {description && <div style={{ fontSize:11, color:'#64748b', marginTop:8, lineHeight:1.5 }}>{description}</div>}
      </div>

      {/* Cards */}
      <div style={{ flex:1, overflow:'auto', padding:'12px' }}>
        {steps.map((step, i) => {
          const c = cards[i];
          const col = statusColors[c.status];
          return (
            <div key={i} style={{ background:col.bg, border:`1.5px solid ${col.border}`, borderRadius:10, padding:'12px 14px', marginBottom:10, transition:'border 0.15s' }}>
              <div style={{ display:'flex', gap:10, alignItems:'flex-start', marginBottom:8 }}>
                <div style={{ background:'#0f172a', color:'#fff', borderRadius:5, width:20, height:20, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, flexShrink:0 }}>{i+1}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#1e293b', marginBottom:2 }}>{step.text}</div>
                  {step.detail && <div style={{ fontSize:11, color:'#64748b', lineHeight:1.5 }}>{step.detail}</div>}
                </div>
              </div>
              {/* Status toggles */}
              <div style={{ display:'flex', gap:6, marginBottom: c.status === 'flagged' ? 8 : 0 }}>
                {(['pending','approved','flagged'] as CardStatus[]).map(s => (
                  <button key={s} onClick={()=>setCard(i,{status:s})}
                    style={{ fontSize:10, fontWeight:600, padding:'3px 10px', borderRadius:999, cursor:'pointer', border: c.status===s ? 'none' : '1px solid #e2e8f0',
                      background: c.status===s ? (s==='approved'?'#16a34a':s==='flagged'?'#f97316':'#64748b') : '#fff',
                      color: c.status===s ? '#fff' : '#94a3b8' }}>
                    {statusColors[s].label}
                  </button>
                ))}
              </div>
              {c.status === 'flagged' && (
                <input value={c.note} onChange={e=>setCard(i,{note:e.target.value})} placeholder="What's the issue?"
                  style={{ width:'100%', border:'1px solid #fdba74', borderRadius:6, padding:'6px 10px', fontSize:11, outline:'none', background:'#fff', fontFamily:'system-ui', boxSizing:'border-box' }} />
              )}
            </div>
          );
        })}
        {/* Overall notes */}
        <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:'12px 14px' }}>
          <div style={{ fontSize:9, fontWeight:700, letterSpacing:2, textTransform:'uppercase', color:'#94a3b8', marginBottom:8 }}>Overall notes</div>
          <textarea value={overall} onChange={e=>setOverall(e.target.value)} placeholder="Any overall feedback…" rows={2}
            style={{ width:'100%', border:'none', outline:'none', resize:'none', fontSize:11, color:'#475569', fontFamily:'system-ui', lineHeight:1.6, boxSizing:'border-box' }} />
        </div>
      </div>
    </div>
  );
}