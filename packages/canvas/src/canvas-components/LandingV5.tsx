export default function LandingV5() {
  const feats = ['Real-time AI drawing','Live React components','Bidirectional SSE sync','Persistent canvas state'];
  return (
    <div style={{fontFamily:'system-ui',background:'#fdf8f0',height:'100%',overflow:'auto',color:'#1c1917'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <b style={{fontSize:14,letterSpacing:'-0.5px'}}>agent<span style={{color:'#f97316'}}>-canvas</span></b>
        <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'6px 16px',fontSize:11,fontWeight:700}}>Try it free</button>
      </nav>
      <div style={{padding:'36px 20px'}}>
        <div style={{background:'#fff3e0',border:'1px solid #fed7aa',borderRadius:999,display:'inline-block',padding:'4px 14px',fontSize:9,fontWeight:700,color:'#c2410c',letterSpacing:1,marginBottom:18}}>✦ NOW IN OPEN BETA</div>
        <h1 style={{fontSize:36,fontWeight:900,lineHeight:1.1,letterSpacing:'-2px',margin:'0 0 16px'}}>Your AI has<br/>a <span style={{color:'#f97316'}}>paintbrush</span> now.</h1>
        <p style={{fontSize:12,color:'#78716c',lineHeight:1.75,margin:'0 0 24px'}}>agent-canvas puts Claude right on your shared tldraw whiteboard — drawing, sketching, and annotating alongside you in real time.</p>
        <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'12px 28px',fontSize:13,fontWeight:700,cursor:'pointer',width:'100%',marginBottom:12}}>Get early access →</button>
        <button style={{background:'transparent',color:'#78716c',border:'1px solid #e7e5e4',borderRadius:999,padding:'11px 28px',fontSize:12,cursor:'pointer',width:'100%',marginBottom:28}}>See how it works</button>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          {feats.map((f,i)=>(
            <div key={i} style={{background:'#fff',border:'1px solid #e7e5e4',borderRadius:12,padding:'14px 16px',fontSize:11,fontWeight:600,color:'#44403c',display:'flex',gap:8,alignItems:'center'}}>
              <span style={{color:'#f97316',fontWeight:900}}>✦</span>{f}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}