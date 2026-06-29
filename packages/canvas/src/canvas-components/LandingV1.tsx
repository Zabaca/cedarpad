export default function LandingV1() {
  const feats = ['Real-time AI drawing on shared canvas','Live React components from the agent','SSE sync — human and AI in lockstep','Persistent JSON canvas, survives restarts'];
  return (
    <div style={{fontFamily:'system-ui',background:'#fafafa',height:'100%',overflow:'auto',color:'#111'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #e5e5e5',background:'#fff'}}>
        <b style={{letterSpacing:'-0.5px',fontSize:14}}>agent-canvas</b>
        <button style={{background:'#111',color:'#fff',border:'none',borderRadius:4,padding:'5px 12px',fontSize:11,fontWeight:600}}>Try it</button>
      </nav>
      <div style={{padding:'40px 20px 24px'}}>
        <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#999',margin:'0 0 14px'}}>POC · Claude + tldraw</p>
        <h1 style={{fontSize:34,fontWeight:900,lineHeight:1.05,letterSpacing:'-2px',margin:'0 0 14px'}}>An AI that<br/>draws with you.</h1>
        <p style={{fontSize:12,color:'#666',lineHeight:1.7,margin:'0 0 24px'}}>Put a Claude agent on your shared whiteboard. It sketches, annotates, and responds to your pen in real time.</p>
        <div style={{display:'flex',gap:8,marginBottom:36}}>
          <button style={{background:'#111',color:'#fff',border:'none',borderRadius:4,padding:'9px 18px',fontSize:11,fontWeight:700}}>Get access</button>
          <button style={{background:'transparent',color:'#666',border:'1px solid #ddd',borderRadius:4,padding:'9px 16px',fontSize:11}}>GitHub →</button>
        </div>
        <div style={{borderTop:'1px solid #eee',paddingTop:20}}>
          <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#bbb',margin:'0 0 14px'}}>Features</p>
          {feats.map((f,i)=><div key={i} style={{display:'flex',gap:8,marginBottom:9,fontSize:11,color:'#444',lineHeight:1.5}}><span style={{fontWeight:700}}>—</span>{f}</div>)}
        </div>
      </div>
    </div>
  );
}