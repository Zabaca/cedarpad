export default function CloneLanding4() {
  const plans = [
    { name: "Starter", price: "$49", period: "/mo", desc: "Hosted API", color: "#e2e8f0", items: ["1 identity model", "200 videos/mo", "720p output", "API access"] },
    { name: "Studio", price: "$299", period: "/mo", desc: "Most popular", color: "#a855f7", items: ["5 identity models", "2,000 videos/mo", "4K output", "Custom scenes", "Priority GPU"] },
    { name: "Enterprise", price: "Custom", period: "", desc: "Self-hosted", color: "#06b6d4", items: ["Unlimited models", "On-prem GPU", "SLA", "White-label", "Dedicated support"] },
  ];
  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", fontFamily: "'Inter', system-ui, sans-serif", background: "#0f0a1e", color: "#e2e8f0" }}>
      {/* Gradient orbs */}
      <div style={{ position: "fixed", top: -100, left: -100, width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, #7c3aed33, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: -100, right: -100, width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, #06b6d433, transparent 70%)", pointerEvents: "none" }} />

      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: "linear-gradient(135deg, #7c3aed, #06b6d4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, color: "#fff" }}>C</div>
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.02em" }}>Cloner</span>
        </div>
        <button style={{ background: "linear-gradient(90deg, #7c3aed, #06b6d4)", color: "#fff", border: "none", borderRadius: 99, padding: "7px 18px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
          Start free trial
        </button>
      </nav>

      {/* Hero */}
      <div style={{ padding: "32px 24px 28px", textAlign: "center", position: "relative" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#ffffff0a", border: "1px solid #ffffff14", borderRadius: 99, padding: "4px 12px 4px 6px", marginBottom: 18 }}>
          <span style={{ background: "linear-gradient(90deg,#7c3aed,#06b6d4)", borderRadius: 99, width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 900 }}>✦</span>
          <span style={{ fontSize: 9, color: "#a8a29e", fontWeight: 600 }}>Identity-locked digital twin video</span>
        </div>
        <h1 style={{ fontSize: 38, fontWeight: 900, letterSpacing: "-0.05em", lineHeight: 1.0, margin: "0 0 16px" }}>
          The only video AI<br />
          <span style={{ background: "linear-gradient(90deg, #a855f7, #06b6d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>built around you.</span>
        </h1>
        <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.8, maxWidth: 300, margin: "0 auto 28px" }}>
          Not a face-swap. Not a filter. Cloner builds a precise identity model — so every video is unmistakably, reliably you.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button style={{ background: "linear-gradient(90deg, #7c3aed, #06b6d4)", color: "#fff", border: "none", borderRadius: 99, padding: "12px 28px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Get started free
          </button>
          <button style={{ background: "transparent", border: "1px solid #ffffff22", color: "#e2e8f0", borderRadius: 99, padding: "12px 20px", fontSize: 12, cursor: "pointer" }}>
            Watch demo ▶
          </button>
        </div>
      </div>

      {/* Pricing cards */}
      <div style={{ padding: "0 20px 28px" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#64748b", textAlign: "center", marginBottom: 16 }}>Pricing</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plans.map((p, i) => (
            <div key={p.name} style={{
              background: i === 1 ? "linear-gradient(135deg, #7c3aed22, #06b6d422)" : "#ffffff08",
              border: `1px solid ${i === 1 ? "#7c3aed55" : "#ffffff11"}`,
              borderRadius: 12, padding: "14px 16px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                  <div style={{ fontSize: 9, color: "#64748b" }}>{p.desc}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 20, fontWeight: 900, color: p.color }}>{p.price}</span>
                  <span style={{ fontSize: 9, color: "#64748b" }}>{p.period}</span>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {p.items.map(item => (
                  <span key={item} style={{ fontSize: 9.5, color: "#94a3b8", display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ color: p.color, fontSize: 8 }}>✓</span>{item}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
