export default function LandingV7() {
  const testimonials = [
    {q:'"Finally an AI that works with my hands, not just my keyboard."', a:'— Designer, Figma user'},
    {q:'"Replaced 3 diagramming tools in one afternoon."', a:'— Staff Eng, Series B startup'},
    {q:'"The live React components blew my mind."', a:'— Solo founder'},
  ];
  const feats = [['⚡','Zero latency','SSE push keeps human and AI in perfect sync'],['🎨','Draws anything','Shapes, charts, Mermaid diagrams, custom React'],['🔌','Open bridge','Bun HTTP server — embed in any stack'],['💾','Always saved','JSON persistence, nothing lost on restart']];
  return (
    <div style={{fontFamily:'system-ui',background:'#fdf8f0',height:'100%',overflow:'auto',color:'#1c1917'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <b style={{fontSize:14,letterSpacing:'-0.5px'}}>agent<span style={{color:'#f97316'}}>-canvas</span></b>
        <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'6px 16px',fontSize:11,fontWeight:700}}>Try it free</button>
      </nav>

      {/* Hero */}
      <div style={{padding:'40px 20px 28px'}}>
        <div style={{background:'#fff3e0',border:'1px solid #fed7aa',borderRadius:999,display:'inline-block',padding:'4px 14px',fontSize:9,fontWeight:700,color:'#c2410c',letterSpacing:1,marginBottom:16}}>✦ OPEN BETA</div>
        <h1 style={{fontSize:36,fontWeight:900,lineHeight:1.05,letterSpacing:'-2px',margin:'0 0 14px'}}>The canvas where<br/><span style={{color:'#f97316'}}>Claude draws.</span></h1>
        <p style={{fontSize:12,color:'#78716c',lineHeight:1.75,margin:'0 0 22px'}}>Put a Claude agent on your shared tldraw whiteboard. Watch it sketch architecture, render live charts, and respond to your pen — in real time.</p>
        <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'12px 0',fontSize:13,fontWeight:700,cursor:'pointer',width:'100%',marginBottom:8}}>Get early access →</button>
        <button style={{background:'transparent',color:'#78716c',border:'1px solid #e7e5e4',borderRadius:999,padding:'10px 0',fontSize:12,cursor:'pointer',width:'100%'}}>Watch 2-min demo</button>
      </div>

      {/* Canvas mockup */}
      <div style={{margin:'0 20px 28px',background:'#fff',border:'1px solid #f5e6d0',borderRadius:12,overflow:'hidden'}}>
        <div style={{background:'#f5f5f4',padding:'8px 12px',display:'flex',gap:6,alignItems:'center',borderBottom:'1px solid #f5e6d0'}}>
          {['#ef4444','#f59e0b','#22c55e'].map(c=><div key={c} style={{width:8,height:8,borderRadius:'50%',background:c}}/>)}
          <span style={{fontSize:9,color:'#a8a29e',marginLeft:8}}>agent-canvas — localhost:5173</span>
        </div>
        <div style={{background:'#fafaf9',height:110,position:'relative',overflow:'hidden'}}>
          <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',opacity:0.2}}><defs><pattern id="g7" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0L0 0 0 20" fill="none" stroke="#a8a29e" strokeWidth="0.5"/></pattern></defs><rect width="100%" height="100%" fill="url(#g7)"/></svg>
          {[['Browser',20,35,'#fff3e0','#fed7aa','#c2410c'],['Bridge',130,35,'#dcfce7','#86efac','#15803d'],['Agent',240,35,'#f0fdf4','#4ade80','#166534']].map(([l,x,y,bg,br,tc])=>(
            <div key={l} style={{position:'absolute',left:x,top:y,background:bg,border:`1.5px solid ${br}`,borderRadius:6,padding:'5px 12px',fontSize:10,fontWeight:700,color:tc}}>{l}</div>
          ))}
          <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}}><defs><marker id="a7" markerWidth="5" markerHeight="5" refX="5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#a8a29e"/></marker></defs><line x1="88" y1="47" x2="125" y2="47" stroke="#a8a29e" strokeWidth="1.5" markerEnd="url(#a7)"/><line x1="198" y1="47" x2="235" y2="47" stroke="#a8a29e" strokeWidth="1.5" markerEnd="url(#a7)"/></svg>
          <div style={{position:'absolute',bottom:10,right:12,background:'#1c1917',color:'#f97316',fontSize:9,padding:'4px 10px',borderRadius:999,fontWeight:600}}>✦ Claude is drawing…</div>
        </div>
      </div>

      {/* Features */}
      <div style={{padding:'0 20px 24px'}}>
        {feats.map(([icon,title,desc])=>(
          <div key={title} style={{display:'flex',gap:12,marginBottom:16}}>
            <div style={{fontSize:18,flexShrink:0}}>{icon}</div>
            <div>
              <div style={{fontWeight:700,fontSize:12,marginBottom:2}}>{title}</div>
              <div style={{fontSize:11,color:'#78716c',lineHeight:1.5}}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Testimonials */}
      <div style={{background:'#fff7ed',borderTop:'1px solid #f5e6d0',padding:'24px 20px'}}>
        <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#a8a29e',margin:'0 0 16px',textAlign:'center'}}>What people are saying</p>
        {testimonials.map((t,i)=>(
          <div key={i} style={{background:'#fff',border:'1px solid #f5e6d0',borderRadius:12,padding:'14px 16px',marginBottom:10}}>
            <p style={{fontSize:11,color:'#1c1917',fontStyle:'italic',margin:'0 0 6px',lineHeight:1.5}}>{t.q}</p>
            <p style={{fontSize:10,color:'#a8a29e',margin:0,fontWeight:600}}>{t.a}</p>
          </div>
        ))}
      </div>

      {/* Footer CTA */}
      <div style={{padding:'24px 20px',textAlign:'center'}}>
        <h2 style={{fontSize:22,fontWeight:900,letterSpacing:'-1px',margin:'0 0 8px'}}>Start drawing with AI.</h2>
        <p style={{fontSize:11,color:'#78716c',margin:'0 0 16px'}}>Free to self-host. Open source. MIT licensed.</p>
        <button style={{background:'#1c1917',color:'#fff',border:'none',borderRadius:999,padding:'12px 28px',fontSize:12,fontWeight:700,cursor:'pointer'}}>View on GitHub →</button>
      </div>
    </div>
  );
}