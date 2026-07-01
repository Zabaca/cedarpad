export default function CloneLanding2() {
  const steps = [
    { n: "01", title: "Upload your likeness", desc: "A 60-second video is all it takes. We extract your identity signature." },
    { n: "02", title: "Write your script", desc: "Type what you want to say. Any language, any tone, any length." },
    { n: "03", title: "Generate & deliver", desc: "Your digital twin delivers it. Indistinguishable. Every time." },
  ];
  return (
    <div style={{ width: "100%", height: "100%", background: "#fafaf9", color: "#1c1917", fontFamily: "'Inter', system-ui, sans-serif", overflow: "auto" }}>

      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderBottom: "1px solid #e7e5e4" }}>
        <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.03em", color: "#1c1917" }}>Cloner</span>
        <button style={{ background: "#1c1917", color: "#fff", border: "none", borderRadius: 6, padding: "7px 18px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
          Request access
        </button>
      </nav>

      {/* Hero */}
      <div style={{ padding: "48px 24px 32px", textAlign: "center" }}>
        <span style={{ display: "inline-block", fontSize: 9, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#78716c", background: "#f5f5f4", border: "1px solid #e7e5e4", borderRadius: 99, padding: "3px 12px", marginBottom: 20 }}>
          Digital-twin video at scale
        </span>
        <h1 style={{ fontSize: 36, fontWeight: 900, letterSpacing: "-0.04em", lineHeight: 1.1, margin: "0 0 16px", color: "#0c0a09" }}>
          Video content that<br />actually looks like <em style={{ fontStyle: "normal", textDecoration: "underline", textDecorationColor: "#e7c000", textUnderlineOffset: 4 }}>you</em>.
        </h1>
        <p style={{ fontSize: 12, color: "#78716c", lineHeight: 1.8, maxWidth: 310, margin: "0 auto 28px" }}>
          Stop re-recording. Cloner creates a locked identity model of you — so every video is recognizably, reliably <strong>you</strong>.
        </p>
        <button style={{ background: "#0c0a09", color: "#fff", border: "none", borderRadius: 8, padding: "13px 32px", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
          Get early access →
        </button>
        <div style={{ fontSize: 10, color: "#a8a29e", marginTop: 8 }}>No credit card. Ships Q3 2025.</div>
      </div>

      {/* How it works */}
      <div style={{ padding: "0 24px 32px" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#a8a29e", textAlign: "center", marginBottom: 20 }}>How it works</div>
        {steps.map((s, i) => (
          <div key={s.n} style={{ display: "flex", gap: 14, marginBottom: i < steps.length - 1 ? 20 : 0, alignItems: "flex-start" }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "#0c0a09", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{s.n}</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#1c1917", marginBottom: 3 }}>{s.title}</div>
              <div style={{ fontSize: 10.5, color: "#78716c", lineHeight: 1.6 }}>{s.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Trust */}
      <div style={{ margin: "0 24px 28px", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: "18px" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#a8a29e", marginBottom: 12 }}>Identity-first by design</div>
        {[
          "Your likeness never trains on others' data",
          "On-prem GPU deployment available",
          "Content credentials & provenance baked in",
        ].map(f => (
          <div key={f} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 7, fontSize: 11, color: "#44403c" }}>
            <span style={{ color: "#16a34a", fontWeight: 700, fontSize: 12 }}>✓</span>{f}
          </div>
        ))}
      </div>
    </div>
  );
}
