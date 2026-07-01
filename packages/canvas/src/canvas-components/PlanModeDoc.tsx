import { useState, useRef } from 'react';
import { sendToAgent } from '../agent-link';

interface Story { role: string; want: string; benefit: string; }
interface Section {
  id: string;
  title: string;
  body?: string;
  items?: string[];
  stories?: Story[];
}
interface Props {
  title?: string;
  status?: string;
  author?: string;
  date?: string;
  sections?: Section[];
}
interface Comment { id: number; quote: string; text: string; resolved: boolean; }

export default function PlanModeDoc({ title = 'Plan', status = 'Draft', author = 'Claude', date = '', sections = [] }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [bubble, setBubble] = useState<{ quote: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [notes, setNotes] = useState('');
  const [done, setDone] = useState<'approved'|'rejected'|null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Native capture-phase listener so we intercept before tldraw's bubble-phase handler
  useState(() => {
    const stop = (e: PointerEvent) => { e.stopPropagation(); };
    requestAnimationFrame(() => {
      contentRef.current?.addEventListener('pointerdown', stop);
    });
  });

  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const base = ref.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    setBubble({ quote: sel.toString().trim(), x: rect.right - base.left, y: rect.top - base.top });
  };

  const addComment = () => {
    if (!bubble || !draft.trim()) return;
    setComments(p => [...p, { id: Date.now(), quote: bubble.quote, text: draft, resolved: false }]);
    setBubble(null); setDraft('');
    window.getSelection()?.removeAllRanges();
  };

  const submit = async (v: 'approved'|'rejected') => {
    setDone(v);
    const anns = comments.filter(c => !c.resolved).map(c => `  • "${c.quote.slice(0,60)}"\n    → ${c.text}`).join('\n');
    const msg = `[PLAN ${v.toUpperCase()}] ${title}${notes ? `\n\nNotes: ${notes}` : ''}${anns ? `\n\nAnnotations:\n${anns}` : ''}`;
    try { await sendToAgent(msg); } catch {}
  };

  if (done) return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', background: done==='approved'?'#f0fdf4':'#fff1f2', fontFamily:'system-ui', gap:12 }}>
      <div style={{ fontSize:36 }}>{done==='approved'?'✅':'❌'}</div>
      <div style={{ fontWeight:800, fontSize:16, color: done==='approved'?'#15803d':'#be123c' }}>Plan {done==='approved'?'Approved':'Rejected'}</div>
      <button onClick={()=>setDone(null)} style={{ marginTop:8, border:'1px solid #d1d5db', borderRadius:8, padding:'7px 16px', fontSize:11, cursor:'pointer', background:'#fff', color:'#6b7280' }}>Reset</button>
    </div>
  );

  const activeComments = comments.filter(c => !c.resolved);

  return (
    <div ref={ref} style={{ fontFamily:'system-ui', height:'100%', overflow:'hidden', display:'flex', flexDirection:'column', background:'#fff', position:'relative' }} onPointerUp={onMouseUp}>

      {/* Toolbar */}
      <div style={{ borderBottom:'1px solid #e2e8f0', padding:'9px 16px', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0, background:'#fff' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:10, fontWeight:700, color:'#64748b', letterSpacing:0.5 }}>📄 PLAN REVIEW</span>
          <span style={{ background: status==='Draft'?'#f1f5f9':'#fef9c3', color: status==='Draft'?'#64748b':'#854d0e', fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:4 }}>{status}</span>
          {activeComments.length > 0 && <span style={{ background:'#fef9c3', color:'#854d0e', fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999 }}>{activeComments.length} annotation{activeComments.length>1?'s':''}</span>}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={()=>submit('rejected')} style={{ background:'#fff1f2', color:'#be123c', border:'1px solid #fecdd3', borderRadius:6, padding:'5px 12px', fontSize:11, fontWeight:700, cursor:'pointer' }}>✕ Reject</button>
          <button onClick={()=>submit('approved')} style={{ background:'#15803d', color:'#fff', border:'none', borderRadius:6, padding:'5px 12px', fontSize:11, fontWeight:700, cursor:'pointer' }}>✓ Approve</button>
        </div>
      </div>

      <div style={{ flex:1, overflow:'hidden', display:'flex' }}>

        {/* Document body */}
        <div ref={contentRef} style={{ flex:1, overflow:'auto', padding:'28px 32px 32px', borderRight:'1px solid #f1f5f9', minWidth:0, userSelect:'text', WebkitUserSelect:'text', cursor:'text' }}>

          {/* Doc header */}
          <div style={{ marginBottom:28, paddingBottom:20, borderBottom:'2px solid #0f172a' }}>
            <h1 style={{ fontSize:22, fontWeight:900, color:'#0f172a', margin:'0 0 10px', letterSpacing:'-0.5px', lineHeight:1.2 }}>{title}</h1>
            <div style={{ display:'flex', gap:16, fontSize:11, color:'#94a3b8' }}>
              {author && <span><b style={{color:'#64748b'}}>Author:</b> {author}</span>}
              {date && <span><b style={{color:'#64748b'}}>Date:</b> {date}</span>}
              <span><b style={{color:'#64748b'}}>Status:</b> {status}</span>
            </div>
          </div>

          {/* Sections */}
          {sections.map((sec, si) => (
            <div key={sec.id} style={{ marginBottom:28 }}>
              <h2 style={{ fontSize:13, fontWeight:800, color:'#0f172a', margin:'0 0 10px', textTransform:'uppercase', letterSpacing:1, borderLeft:'3px solid #0f172a', paddingLeft:10 }}>{sec.title}</h2>

              {sec.body && <p style={{ fontSize:12, color:'#334155', lineHeight:1.8, margin:'0 0 8px' }}>{sec.body}</p>}

              {sec.items && (
                <ul style={{ margin:'0', paddingLeft:20 }}>
                  {sec.items.map((item, ii) => (
                    <li key={ii} style={{ fontSize:12, color:'#334155', lineHeight:1.8, marginBottom:3 }}>{item}</li>
                  ))}
                </ul>
              )}

              {sec.stories && (
                <div style={{ border:'1px solid #e2e8f0', borderRadius:8, overflow:'hidden', fontSize:11 }}>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr 1.5fr', background:'#f8fafc', padding:'8px 12px', fontWeight:700, color:'#475569', gap:8 }}>
                    <span>As a…</span><span>I want to…</span><span>So that…</span>
                  </div>
                  {sec.stories.map((s, si) => (
                    <div key={si} style={{ display:'grid', gridTemplateColumns:'1fr 2fr 1.5fr', padding:'9px 12px', borderTop:'1px solid #f1f5f9', color:'#334155', gap:8, lineHeight:1.5 }}>
                      <span style={{ fontStyle:'italic' }}>{s.role}</span>
                      <span>{s.want}</span>
                      <span style={{ color:'#64748b' }}>{s.benefit}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Overall notes */}
          <div style={{ borderTop:'1px solid #f1f5f9', paddingTop:20, marginTop:8 }}>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:2, textTransform:'uppercase', color:'#94a3b8', marginBottom:8 }}>Your notes</div>
            <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Overall feedback before approving or rejecting…" rows={3}
              style={{ width:'100%', border:'1px solid #e2e8f0', borderRadius:8, padding:'9px 12px', fontSize:12, color:'#475569', outline:'none', resize:'none', fontFamily:'system-ui', lineHeight:1.6, boxSizing:'border-box' }} />
          </div>
        </div>

        {/* Annotation sidebar */}
        <div style={{ width:200, overflow:'auto', padding:'14px 10px', background:'#fafafa', flexShrink:0 }}>
          <div style={{ fontSize:9, fontWeight:700, letterSpacing:1.5, textTransform:'uppercase', color:'#94a3b8', marginBottom:10 }}>Annotations</div>
          {activeComments.length === 0
            ? <div style={{ fontSize:11, color:'#cbd5e1', textAlign:'center', paddingTop:20, lineHeight:1.7 }}>Select any text<br/>to annotate</div>
            : activeComments.map(c => (
              <div key={c.id} style={{ background:'#fff', border:'1px solid #fde68a', borderLeft:'3px solid #f59e0b', borderRadius:8, padding:'9px 10px', marginBottom:10 }}>
                <div style={{ fontSize:10, fontStyle:'italic', color:'#78716c', marginBottom:5, lineHeight:1.5, fontFamily:'Georgia,serif' }}>"{c.quote.length>60?c.quote.slice(0,60)+'…':c.quote}"</div>
                <div style={{ fontSize:11, color:'#1c1917', lineHeight:1.5, marginBottom:7 }}>{c.text}</div>
                <button onClick={()=>setComments(p=>p.map(x=>x.id===c.id?{...x,resolved:true}:x))}
                  style={{ fontSize:10, color:'#a8a29e', background:'transparent', border:'none', cursor:'pointer', padding:0 }}>✓ Resolve</button>
              </div>
            ))
          }
        </div>
      </div>

      {/* Floating comment input */}
      {bubble && (
        <div style={{ position:'absolute', left:Math.min(bubble.x+6,500), top:Math.max(bubble.y-8,54), background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, boxShadow:'0 4px 20px rgba(0,0,0,0.12)', padding:13, zIndex:100, width:230 }}>
          <div style={{ fontSize:10, color:'#94a3b8', marginBottom:7, lineHeight:1.5 }}>💬 <em>"{bubble.quote.length>50?bubble.quote.slice(0,50)+'…':bubble.quote}"</em></div>
          <textarea autoFocus value={draft} onChange={e=>setDraft(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();addComment();} }}
            placeholder="Annotate… (Enter to save)" rows={2}
            style={{ width:'100%', border:'1px solid #e2e8f0', borderRadius:6, padding:'6px 8px', fontSize:11, outline:'none', resize:'none', fontFamily:'system-ui', boxSizing:'border-box' }} />
          <div style={{ display:'flex', gap:6, marginTop:7, justifyContent:'flex-end' }}>
            <button onClick={()=>setBubble(null)} style={{ fontSize:11, color:'#94a3b8', background:'transparent', border:'none', cursor:'pointer' }}>Cancel</button>
            <button onClick={addComment} style={{ background:'#0f172a', color:'#fff', border:'none', borderRadius:6, padding:'5px 12px', fontSize:11, fontWeight:700, cursor:'pointer' }}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}