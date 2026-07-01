export default function CloneLanding1() {
  return (
    <div style={{ width: "100%", height: "100%", background: "#000", color: "#fff", fontFamily: "'Inter', system-ui, sans-serif", overflow: "auto", display: "flex", flexDirection: "column" }}>

      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid #ffffff0d", flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-0.03em" }}>cloner<span style={{ color: "#a855f7" }}>.</span></span>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {["Product", "Pricing", "Docs"].map(l => <span key={l} style={{ fontSize: 10, color: "#666", cursor: "pointer" }}>{l}</span>)}
          <button style={{ background: "#a855f7", color: "#fff", border: "none", borderRadius: 99, padding: "6px 16px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Early access</button>
        </div>
      </nav>

      {/* Hero */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: "#a855f7", marginBottom: 16, border: "1px solid #a855f722", borderRadius: 99, padding: "4px 12px" }}>
          Digital twin video · Identity-locked
        </div>
        <h1 style={{ fontSize: 42, fontWeight: 900, letterSpacing: "-0.05em", lineHeight: 1.0, margin: "0 0 20px", maxWidth: 380 }}>
          Your face.<br />
          <span style={{ background: "linear-gradient(90deg, #a855f7, #06b6d4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Any scene.</span>
        </h1>
        <p style={{ fontSize: 12, color: "#888", lineHeight: 1.75, maxWidth: 300, margin: "0 0 32px" }}>
          Cloner generates reliable digital-twin video with identity-lock precision. Your likeness, your voice — in any context at scale.
        </p>

        <div style={{ display: "flex", gap: 10, marginBottom: 40 }}>
          <button style={{ background: "#a855f7", color: "#fff", border: "none", borderRadius: 99, padding: "12px 28px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Get early access →
          </button>
          <button style={{ background: "transparent", color: "#fff", border: "1px solid #333", borderRadius: 99, padding: "12px 24px", fontSize: 12, cursor: "pointer" }}>
            See a demo
          </button>
        </div>

        {/* Feature pills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 360 }}>
          {["Identity-locked avatar", "Voice cloning", "Scene compositing", "Self-hosted at scale", "HunyuanVideo-Avatar"].map(f => (
            <span key={f} style={{ fontSize: 10, color: "#999", border: "1px solid #222", borderRadius: 99, padding: "4px 12px", background: "#0d0d0d" }}>{f}</span>
          ))}
        </div>
      </div>

      {/* Social proof strip */}
      <div style={{ borderTop: "1px solid #ffffff0d", padding: "16px 24px", display: "flex", justifyContent: "center", gap: 32, flexShrink: 0 }}>
        {[
          { label: "Identity accuracy", value: "99.2%" },
          { label: "Latency", value: "<2s" },
          { label: "Self-hosted", value: "GPU" },
        ].map(s => (
          <div key={s.label} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#a855f7" }}>{s.value}</div>
            <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
