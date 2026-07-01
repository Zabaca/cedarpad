export default function LandingV3() {
  const feats = [['Real-time','AI draws as you watch'],['Composable','Shapes + live React cards'],['In sync','SSE, zero latency'],['Persistent','Survives restarts']];
  return (
    <div style={{fontFamily:'system-ui',background:'#050814',height:'100%',overflow:'auto',color:'#fff'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <b style={{background:'linear-gradient(90deg,#818cf8,#38bdf8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',fontSize:14}}>agent-canvas</b>
        <button style={{background:'linear-gradient(90deg,#6366f1,#8b5cf6)',color:'#fff',border:'none',borderRadius:20,padding:'6px 14px',fontSize:11,fontWeight:700}}>Early access</button>
      </nav>
      <div style={{padding:'36px 20px',textAlign:'center'}}>
        <div style={{display:'inline-block',background:'rgba(99,102,241,0.15)',border:'1px solid rgba(99,102,241,0.3)',borderRadius:20,padding:'3px 12px',fontSize:9,color:'#818cf8',fontWeight:700,letterSpacing:1,marginBottom:18}}>CLAUDE + TLDRAW + BUN</div>
        <h1 style={{fontSize:36,fontWeight:900,lineHeight:1.05,letterSpacing:'-2px',margin:'0 0 14px',background:'linear-gradient(135deg,#fff,#818cf8,#38bdf8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>AI that draws<br/>with you</h1>
        <p style={{fontSize:12,color:'#64748b',lineHeight:1.7,margin:'0 0 24px'}}>Claude on your shared whiteboard — sketching, annotating, responding in real time.</p>
        <button style={{background:'linear-gradient(90deg,#6366f1,#8b5cf6)',color:'#fff',border:'none',borderRadius:8,padding:'12px 0',fontSize:13,fontWeight:700,width:'100%',marginBottom:28,boxShadow:'0 0 24px rgba(99,102,241,0.4)',cursor:'pointer'}}>Get early access →</button>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,textAlign:'left'}}>
          {feats.map(([t,d])=>(
            <div key={t} style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:10,padding:'14px'}}>
              <div style={{fontWeight:700,fontSize:12,marginBottom:4}}>{t}</div>
              <div style={{fontSize:11,color:'#64748b'}}>{d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}