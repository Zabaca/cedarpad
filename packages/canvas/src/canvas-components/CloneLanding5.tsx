export default function CloneLanding5() {
  const usecases = [
    { emoji: "🎯", title: "Sales outreach", desc: "Personalized video for every prospect. Same you. 10,000 variations." },
    { emoji: "📚", title: "Course creation", desc: "Update one module without re-filming everything." },
    { emoji: "🌍", title: "Multilingual content", desc: "Your face, your voice — translated and lip-synced." },
    { emoji: "🏢", title: "Executive comms", desc: "Weekly all-hands at scale. Record once, deliver everywhere." },
  ];

  const compare = [
    { label: "Looks like you", cloner: true, others: false },
    { label: "Voice matched", cloner: true, others: false },
    { label: "Identity-locked", cloner: true, others: false },
    { label: "Self-hostable", cloner: true, others: false },
    { label: "API-first", cloner: true, others: true },
    { label: "Fast generation", cloner: true, others: true },
  ];

  return (
    <div style={{ width: "100%", height: "100%", background: "#fff", color: "#111", fontFamily: "'Inter', system-ui, sans-serif", overflow: "auto" }}>

      {/* Top bar */}
      <div style={{ background: "#111", color: "#fff", padding: "8px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "#888" }}>Now in early access</span>
        <span style={{ fontSize: 9, color: "#a855f7", fontWeight: 700, cursor: "pointer" }}>Join waitlist →</span>
      </div>

      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderBottom: "1px solid #f1f5f9" }}>
        <span style={{ fontSize: 15, fontWeight: 900, letterSpacing: "-0.04em" }}>Cloner</span>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {["Use cases", "Compare", "Pricing"].map(l => <span key={l} style={{ fontSize: 10, color: "#666", cursor: "pointer" }}>{l}</span>)}
          <button style={{ background: "#111", color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Get access</button>
        </div>
      </nav>

      {/* Hero */}
      <div style={{ padding: "36px 24px 28px" }}>
        <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 99, display: "inline-block", padding: "3px 12px", fontSize: 9, color: "#7c3aed", fontWeight: 700, marginBottom: 16, letterSpacing: "0.05em" }}>
          IDENTITY-LOCKED DIGITAL TWIN
        </div>
        <h1 style={{ fontSize: 34, fontWeight: 900, letterSpacing: "-0.04em", lineHeight: 1.08, margin: "0 0 14px" }}>
          Video that scales.<br />Identity that doesn't.
        </h1>
        <p style={{ fontSize: 12, color: "#555", lineHeight: 1.75, maxWidth: 340, margin: "0 0 24px" }}>
          Generic AI avatars look generic. Cloner builds a precision model of your face and voice — so the output is unmistakably you, at any scale.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8, padding: "12px 24px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Join waitlist
          </button>
          <button style={{ background: "transparent", color: "#111", border: "1px solid #e2e8f0", borderRadius: 8, padding: "12px 20px", fontSize: 12, cursor: "pointer" }}>
            See example videos
          </button>
        </div>
      </div>

      {/* Use cases */}
      <div style={{ padding: "0 24px 24px" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 14 }}>Use cases</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {usecases.map(u => (
            <div key={u.title} style={{ background: "#f8fafc", border: "1px solid #f1f5f9", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 18, marginBottom: 6 }}>{u.emoji}</div>
              <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 3, color: "#0f172a" }}>{u.title}</div>
              <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>{u.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Comparison table */}
      <div style={{ padding: "0 24px 28px" }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 14 }}>vs. other AI video tools</div>
        <div style={{ background: "#f8fafc", border: "1px solid #f1f5f9", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", padding: "8px 16px", borderBottom: "1px solid #f1f5f9", background: "#f1f5f9" }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "#64748b" }}>Feature</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: "#7c3aed", width: 60, textAlign: "center" }}>Cloner</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", width: 60, textAlign: "center" }}>Others</span>
          </div>
          {compare.map((row, i) => (
            <div key={row.label} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", padding: "9px 16px", borderBottom: i < compare.length - 1 ? "1px solid #f1f5f9" : "none", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#374151" }}>{row.label}</span>
              <span style={{ width: 60, textAlign: "center", fontSize: 14 }}>{row.cloner ? "✓" : "✗"}</span>
              <span style={{ width: 60, textAlign: "center", fontSize: 12, color: row.others ? "#22c55e" : "#e5e7eb" }}>{row.others ? "✓" : "–"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
