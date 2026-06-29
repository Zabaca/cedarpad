export default function LandingV2() {
  const feats = ['> Real-time AI drawing on shared canvas','> Live React components from the agent','> SSE sync — human and AI in lockstep','> Persistent JSON canvas, survives restarts'];
  return (
    <div style={{fontFamily:'"Courier New",monospace',background:'#0a0a0a',height:'100%',overflow:'auto',color:'#4ade80'}}>
      <div style={{padding:'14px 20px',borderBottom:'1px solid #1a1a1a',display:'flex',justifyContent:'space-between'}}>
        <span style={{fontWeight:700,fontSize:13}}>agent-canvas v0.1.0</span>
        <span style={{color:'#444',fontSize:11}}>localhost:5173</span>
      </div>
      <div style={{padding:'32px 20px'}}>
        <p style={{fontSize:10,color:'#444',margin:'0 0 6px'}}>{'//'} system architecture POC</p>
        <h1 style={{fontSize:30,fontWeight:900,lineHeight:1.1,margin:'0 0 16px',color:'#fff'}}>
          {'>'} AI that draws<br/>
          <span style={{color:'#4ade80'}}>{'>'} with you_</span>
        </h1>
        <p style={{fontSize:11,color:'#666',lineHeight:1.7,margin:'0 0 20px'}}>Put Claude on your tldraw canvas.<br/>Watch it sketch and respond to your pen.</p>
        <div style={{background:'#111',border:'1px solid #1e3a1e',borderRadius:4,padding:14,marginBottom:24}}>
          <p style={{fontSize:11,margin:'0 0 6px'}}>$ bun run dev</p>
          <p style={{fontSize:11,color:'#666',margin:'0 0 4px'}}>Bridge listening on :4511</p>
          <p style={{fontSize:11,color:'#666',margin:'0 0 4px'}}>Canvas UI on :5173</p>
          <p style={{fontSize:11,margin:0}}>Agent ready. Start chatting.</p>
        </div>
        <p style={{fontSize:9,color:'#333',letterSpacing:1,textTransform:'uppercase',margin:'0 0 10px'}}>{'//'} capabilities</p>
        {feats.map((f,i)=><p key={i} style={{fontSize:11,margin:'0 0 6px'}}>{f}</p>)}
        <button style={{marginTop:20,background:'#4ade80',color:'#0a0a0a',border:'none',padding:'10px 0',fontSize:11,fontWeight:900,borderRadius:2,width:'100%',cursor:'pointer'}}>
          $ get_early_access --now
        </button>
      </div>
    </div>
  );
}