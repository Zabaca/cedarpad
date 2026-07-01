export default function LandingV6() {
  const steps = [
    ['01', 'Open the canvas', 'Spin up the bridge and open tldraw in your browser.'],
    ['02', 'Chat with Claude', 'Type naturally — ask it to draw, diagram, or annotate.'],
    ['03', 'Watch it appear', 'Shapes and components render live as Claude responds.'],
  ];
  const feats = ['Real-time AI drawing','Live React components','Bidirectional SSE sync','Persistent canvas state','Open Bun bridge'];
  return (
    <div style={{fontFamily:'system-ui',background:'#fdf8f0',height:'100%',overflow:'auto',color:'#1c1917'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #f5e6d0'}}>
        <b style={{fontSize:14,letterSpacing:'-0.5px'}}>agent<span style={{color:'#f97316'}}>-canvas</span></b>
        <div style={{display:'flex',gap:8}}>
          <a style={{fontSize:11,color:'#78716c',textDecoration:'none',padding:'6px 10px'}}>Docs</a>
          <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'6px 16px',fontSize:11,fontWeight:700}}>Try it free</button>
        </div>
      </nav>

      {/* Hero */}
      <div style={{padding:'48px 20px 36px',textAlign:'center'}}>
        <div style={{background:'#fff3e0',border:'1px solid #fed7aa',borderRadius:999,display:'inline-block',padding:'4px 14px',fontSize:9,fontWeight:700,color:'#c2410c',letterSpacing:1,marginBottom:18}}>✦ NOW IN OPEN BETA</div>
        <h1 style={{fontSize:38,fontWeight:900,lineHeight:1.05,letterSpacing:'-2px',margin:'0 0 14px'}}>Your AI has<br/>a <span style={{color:'#f97316'}}>paintbrush</span> now.</h1>
        <p style={{fontSize:12,color:'#78716c',lineHeight:1.75,margin:'0 auto 24px',maxWidth:320}}>agent-canvas puts Claude right on your shared tldraw whiteboard — drawing, sketching, and annotating alongside you in real time.</p>
        <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'13px 32px',fontSize:13,fontWeight:700,cursor:'pointer',width:'100%',marginBottom:10}}>Get early access →</button>
        <button style={{background:'transparent',color:'#78716c',border:'1px solid #e7e5e4',borderRadius:999,padding:'11px 32px',fontSize:12,cursor:'pointer',width:'100%'}}>See how it works ↓</button>
      </div>

      {/* Social proof */}
      <div style={{background:'#fff7ed',borderTop:'1px solid #f5e6d0',borderBottom:'1px solid #f5e6d0',padding:'14px 20px',textAlign:'center'}}>
        <p style={{fontSize:10,color:'#a8a29e',margin:'0 0 10px',letterSpacing:1,fontWeight:600}}>USED BY TEAMS AT</p>
        <div style={{display:'flex',justifyContent:'space-around',alignItems:'center'}}>
          {['Vercel','Linear','Loom','Notion'].map(n=><span key={n} style={{fontSize:12,fontWeight:800,color:'#d4c4b0',letterSpacing:'-0.5px'}}>{n}</span>)}
        </div>
      </div>

      {/* How it works */}
      <div style={{padding:'32px 20px'}}>
        <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#a8a29e',margin:'0 0 20px',textAlign:'center'}}>How it works</p>
        {steps.map(([num,title,desc])=>(
          <div key={num} style={{display:'flex',gap:16,marginBottom:20,alignItems:'flex-start'}}>
            <div style={{background:'#f97316',color:'#fff',borderRadius:999,width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,flexShrink:0}}>{num}</div>
            <div>
              <div style={{fontWeight:700,fontSize:13,marginBottom:3}}>{title}</div>
              <div style={{fontSize:11,color:'#78716c',lineHeight:1.5}}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Features */}
      <div style={{padding:'0 20px 28px'}}>
        <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#a8a29e',margin:'0 0 14px',textAlign:'center'}}>Everything included</p>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {feats.map((f,i)=>(
            <div key={i} style={{background:'#fff',border:'1px solid #f5e6d0',borderRadius:10,padding:'12px 14px',fontSize:11,fontWeight:600,color:'#44403c',display:'flex',gap:8,alignItems:'center'}}>
              <span style={{color:'#f97316'}}>✦</span>{f}
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div style={{margin:'0 20px 28px',background:'#1c1917',borderRadius:16,padding:'28px 20px',textAlign:'center',color:'#fff'}}>
        <h2 style={{fontSize:22,fontWeight:900,letterSpacing:'-1px',margin:'0 0 8px'}}>Ready to try it?</h2>
        <p style={{fontSize:11,color:'#a8a29e',margin:'0 0 18px',lineHeight:1.6}}>Clone the repo, run the bridge,<br/>and start chatting with your canvas.</p>
        <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'11px 28px',fontSize:12,fontWeight:700,cursor:'pointer'}}>View on GitHub →</button>
      </div>
    </div>
  );
}