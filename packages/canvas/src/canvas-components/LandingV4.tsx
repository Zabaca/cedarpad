export default function LandingV4() {
  const feats = [['🤖','Claude-powered','claude-sonnet drives the agent'],['⚡','Real-time','SSE push, zero-latency updates'],['🧩','Composable','Custom React components on canvas'],['💾','Persistent','JSON state, survives restarts']];
  return (
    <div style={{fontFamily:'system-ui',background:'#fff',height:'100%',overflow:'auto',color:'#0f172a'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #e2e8f0'}}>
        <b style={{fontSize:14,letterSpacing:'-0.5px',color:'#2563eb'}}>agent-canvas</b>
        <button style={{background:'#2563eb',color:'#fff',border:'none',borderRadius:6,padding:'6px 14px',fontSize:11,fontWeight:600}}>Request access</button>
      </nav>
      <div style={{background:'#eff6ff',padding:'36px 20px',textAlign:'center',borderBottom:'1px solid #dbeafe'}}>
        <div style={{display:'inline-block',background:'#dbeafe',color:'#1d4ed8',fontSize:9,fontWeight:700,padding:'3px 10px',borderRadius:4,letterSpacing:1,marginBottom:14}}>ENTERPRISE READY · SOC2 COMING SOON</div>
        <h1 style={{fontSize:30,fontWeight:800,lineHeight:1.1,margin:'0 0 12px',letterSpacing:'-1px'}}>The AI canvas for<br/>your whole team</h1>
        <p style={{fontSize:12,color:'#475569',lineHeight:1.7,margin:'0 0 20px'}}>agent-canvas puts Claude directly on your shared tldraw whiteboard — sketching diagrams, rendering data, responding in real time.</p>
        <div style={{display:'flex',gap:8,justifyContent:'center'}}>
          <button style={{background:'#2563eb',color:'#fff',border:'none',borderRadius:6,padding:'10px 20px',fontSize:12,fontWeight:700,cursor:'pointer'}}>Get started free</button>
          <button style={{background:'#fff',color:'#475569',border:'1px solid #e2e8f0',borderRadius:6,padding:'10px 16px',fontSize:12,cursor:'pointer'}}>Watch demo →</button>
        </div>
      </div>
      <div style={{padding:'24px 20px'}}>
        <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#94a3b8',margin:'0 0 16px'}}>Platform features</p>
        {feats.map(([icon,title,desc])=>(
          <div key={title} style={{display:'flex',gap:12,marginBottom:16,alignItems:'flex-start'}}>
            <div style={{fontSize:18,flexShrink:0,marginTop:1}}>{icon}</div>
            <div>
              <div style={{fontWeight:700,fontSize:12,marginBottom:2}}>{title}</div>
              <div style={{fontSize:11,color:'#64748b'}}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}