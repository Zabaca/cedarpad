import { useState } from 'react';
import { sendToAgent } from '../agent-link';
interface Step { text: string; detail?: string; }
interface Props { title?: string; description?: string; steps?: Step[]; }

export default function PlanModeMinimal({ title = 'Plan', description = '', steps = [] }: Props) {
  const [notes, setNotes] = useState('');
  const [done, setDone] = useState<'approved'|'rejected'|null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (v: 'approved'|'rejected') => {
    setLoading(true);
    const msg = `[PLAN ${v.toUpperCase()}] ${title}${notes ? `\n\nNotes: ${notes}` : ''}`;
    try { await sendToAgent(msg); } catch {}
    setDone(v); setLoading(false);
  };

  if (done) return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', background:done==='approved'?'#f0fdf4':'#fff1f2', fontFamily:'system-ui', gap:10 }}>
      <div style={{ fontSize:32 }}>{done==='approved'?'✅':'❌'}</div>
      <div style={{ fontWeight:800, fontSize:15, color:done==='approved'?'#15803d':'#be123c' }}>Plan {done==='approved'?'Approved':'Rejected'}</div>
      <button onClick={()=>setDone(null)} style={{ marginTop:6, border:'1px solid #d1d5db', borderRadius:8, padding:'6px 14px', fontSize:11, cursor:'pointer', background:'#fff', color:'#6b7280' }}>Reset</button>
    </div>
  );

  return (
    <div style={{ fontFamily:'system-ui', height:'100%', overflow:'auto', background:'#fff', display:'flex', flexDirection:'column' }}>
      {/* Top bar */}
      <div style={{ padding:'12px 16px', borderBottom:'1px solid #f1f5f9', display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
        <span style={{ background:'#fef9c3', color:'#854d0e', fontSize:9, fontWeight:800, padding:'2px 8px', borderRadius:4, letterSpacing:1 }}>AWAITING APPROVAL</span>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'20px 20px 12px' }}>
        <div style={{ fontWeight:800, fontSize:17, color:'#0f172a', marginBottom:6, letterSpacing:'-0.5px' }}>{title}</div>
        {description && <div style={{ fontSize:12, color:'#64748b', lineHeight:1.7, marginBottom:20 }}>{description}</div>}

        {/* Step list — read only, clean */}
        <div style={{ marginBottom:20 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display:'flex', gap:12, padding:'10px 0', borderBottom:'1px solid #f8fafc', alignItems:'flex-start' }}>
              <div style={{ fontSize:11, fontWeight:700, color:'#cbd5e1', flexShrink:0, width:18, textAlign:'right', marginTop:1 }}>{i+1}.</div>
              <div>
                <div style={{ fontSize:12, fontWeight:600, color:'#1e293b' }}>{s.text}</div>
                {s.detail && <div style={{ fontSize:11, color:'#94a3b8', marginTop:2, lineHeight:1.5 }}>{s.detail}</div>}
              </div>
            </div>
          ))}
        </div>

        {/* Notes */}
        <div style={{ background:'#f8fafc', borderRadius:10, padding:'12px 14px', marginBottom:16 }}>
          <div style={{ fontSize:9, fontWeight:700, letterSpacing:2, textTransform:'uppercase', color:'#94a3b8', marginBottom:8 }}>Notes (optional)</div>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Any feedback before I proceed…" rows={3}
            style={{ width:'100%', border:'none', background:'transparent', outline:'none', resize:'none', fontSize:12, color:'#475569', fontFamily:'system-ui', lineHeight:1.6, boxSizing:'border-box' }} />
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding:'12px 16px', borderTop:'1px solid #f1f5f9', display:'flex', gap:10, flexShrink:0 }}>
        <button onClick={()=>submit('rejected')} disabled={loading}
          style={{ flex:1, background:'#fff1f2', color:'#be123c', border:'1.5px solid #fecdd3', borderRadius:8, padding:'11px 0', fontSize:12, fontWeight:700, cursor:'pointer' }}>
          ✕ Reject
        </button>
        <button onClick={()=>submit('approved')} disabled={loading}
          style={{ flex:2, background:'#0f172a', color:'#fff', border:'none', borderRadius:8, padding:'11px 0', fontSize:12, fontWeight:700, cursor:'pointer' }}>
          {loading ? '…' : '✓ Approve plan'}
        </button>
      </div>
    </div>
  );
}