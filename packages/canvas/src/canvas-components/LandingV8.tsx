export default function LandingV8() {
  const pricing = [
    {plan:'Hobby',price:'Free',desc:'Self-hosted',items:['1 canvas','Unlimited shapes','SSE sync','Open source']},
    {plan:'Team',price:'$49/mo',desc:'Hosted',items:['Unlimited canvases','Multi-user sessions','Priority model access','Canvas history']},
    {plan:'Enterprise',price:'Custom',desc:'On-prem',items:['SSO / SAML','Audit logs','Dedicated support','SLA guarantee']},
  ];
  return (
    <div style={{fontFamily:'system-ui',background:'#fdf8f0',height:'100%',overflow:'auto',color:'#1c1917'}}>
      <nav style={{padding:'14px 20px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <b style={{fontSize:14,letterSpacing:'-0.5px'}}>agent<span style={{color:'#f97316'}}>-canvas</span></b>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <span style={{fontSize:11,color:'#78716c'}}>Pricing</span>
          <button style={{background:'#f97316',color:'#fff',border:'none',borderRadius:999,padding:'6px 16px',fontSize:11,fontWeight:700}}>Try free</button>
        </div>
      </nav>

      {/* Hero */}
      <div style={{padding:'36px 20px 24px',textAlign:'center'}}>
        <h1 style={{fontSize:34,fontWeight:900,lineHeight:1.05,letterSpacing:'-2px',margin:'0 0 12px'}}>AI drawing,<br/><span style={{color:'#f97316'}}>for every team.</span></h1>
        <p style={{fontSize:12,color:'#78716c',lineHeight:1.7,margin:'0 auto 24px',maxWidth:300}}>One Claude agent. Your shared whiteboard. Real-time, persistent, and open.</p>
        <div style={{display:'flex',gap:16,justifyContent:'center',marginBottom:8}}>
          {['10k+ shapes drawn','50ms avg latency','MIT licensed'].map(s=>(
            <div key={s} style={{fontSize:10,color:'#78716c',fontWeight:600,display:'flex',alignItems:'center',gap:4}}><span style={{color:'#f97316'}}>✦</span>{s}</div>
          ))}
        </div>
      </div>

      {/* Pricing */}
      <div style={{padding:'0 20px 28px'}}>
        <p style={{fontSize:9,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'#a8a29e',margin:'0 0 16px',textAlign:'center'}}>Simple pricing</p>
        {pricing.map((p,i)=>(
          <div key={p.plan} style={{background:i===1?'#1c1917':'#fff',border:i===1?'2px solid #f97316':'1px solid #f5e6d0',borderRadius:14,padding:'18px',marginBottom:12,color:i===1?'#fff':'#1c1917'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
              <span style={{fontWeight:800,fontSize:14}}>{p.plan}</span>
              <span style={{fontWeight:900,fontSize:18,color:i===1?'#f97316':'#f97316'}}>{p.price}</span>
            </div>
            <div style={{fontSize:10,color:i===1?'#a8a29e':'#a8a29e',marginBottom:12}}>{p.desc}</div>
            {p.items.map(item=>(
              <div key={item} style={{fontSize:11,marginBottom:6,display:'flex',gap:8,color:i===1?'#d4c4b0':'#44403c'}}>
                <span style={{color:'#f97316',fontWeight:700}}>✓</span>{item}
              </div>
            ))}
            <button style={{marginTop:12,width:'100%',background:i===1?'#f97316':'transparent',color:i===1?'#fff':'#f97316',border:`1.5px solid #f97316`,borderRadius:999,padding:'9px 0',fontSize:11,fontWeight:700,cursor:'pointer'}}>
              {i===0?'Clone repo →':i===1?'Get started →':'Contact us →'}
            </button>
          </div>
        ))}
      </div>

      {/* Bottom note */}
      <div style={{padding:'0 20px 28px',textAlign:'center'}}>
        <p style={{fontSize:11,color:'#a8a29e',lineHeight:1.6}}>All plans include the open-source bridge.<br/>No vendor lock-in. Cancel any time.</p>
      </div>
    </div>
  );
}