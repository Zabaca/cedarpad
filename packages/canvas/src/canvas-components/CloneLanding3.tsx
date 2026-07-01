export default function CloneLanding3() {
  const lines = [
    { t: "comment", s: "// Cloner SDK — identity-locked video generation" },
    { t: "comment", s: "// npm install @cloner/sdk" },
    { t: "blank", s: "" },
    { t: "import", s: `import { Cloner } from '@cloner/sdk';` },
    { t: "blank", s: "" },
    { t: "code", s: `const client = new Cloner({` },
    { t: "code", s: `  apiKey: process.env.CLONER_KEY,` },
    { t: "code", s: `  identity: 'james-v1',   // your locked model` },
    { t: "code", s: `});` },
    { t: "blank", s: "" },
    { t: "code", s: `const video = await client.generate({` },
    { t: "code", s: `  script: "Hello, I'm James...",` },
    { t: "code", s: `  scene:  'office-bg',` },
    { t: "code", s: `  voice:  'matched',       // cloned voice` },
    { t: "code", s: `});` },
    { t: "blank", s: "" },
    { t: "output", s: `// → { url: 'https://cdn.cloner.ai/out/...mp4' }` },
    { t: "output", s: `// → Generation: 1.8s | Identity score: 99.4%` },
  ];

  const tokenColor = (t: string) => {
    if (t === "comment") return "#6b7280";
    if (t === "import") return "#7c3aed";
    if (t === "output") return "#16a34a";
    return "#e2e8f0";
  };

  return (
    <div style={{ width: "100%", height: "100%", background: "#0d1117", color: "#e2e8f0", fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px", borderBottom: "1px solid #21262d", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 20, height: 20, background: "#7c3aed", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800 }}>C</div>
          <span style={{ fontSize: 13, fontWeight: 700 }}>cloner</span>
          <span style={{ fontSize: 9, background: "#21262d", border: "1px solid #30363d", borderRadius: 4, padding: "1px 6px", color: "#8b949e" }}>alpha</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "#8b949e" }}>Docs</span>
          <span style={{ fontSize: 10, color: "#8b949e" }}>Pricing</span>
          <button style={{ background: "#7c3aed", color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Sign up</button>
        </div>
      </nav>

      {/* Hero text */}
      <div style={{ padding: "24px 20px 16px", flexShrink: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.04em", margin: "0 0 8px", lineHeight: 1.1 }}>
          Generate video of <span style={{ color: "#7c3aed" }}>you</span>.<br />
          Programmatically.
        </h1>
        <p style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.6, margin: 0, maxWidth: 340 }}>
          One identity model. Infinite video. API-first, GPU-native, self-hostable.
        </p>
      </div>

      {/* Code window */}
      <div style={{ margin: "0 20px 16px", background: "#161b22", border: "1px solid #30363d", borderRadius: 10, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #21262d", display: "flex", gap: 6, alignItems: "center" }}>
          {["#ff5f57", "#ffbd2e", "#28c840"].map(c => <div key={c} style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />)}
          <span style={{ fontSize: 9, color: "#8b949e", marginLeft: 8 }}>generate.ts</span>
        </div>
        <div style={{ padding: "14px", overflow: "auto" }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 16, fontFamily: "monospace", fontSize: 10, lineHeight: 1.7 }}>
              <span style={{ color: "#30363d", width: 16, textAlign: "right", userSelect: "none", flexShrink: 0 }}>{l.t !== "blank" ? i + 1 : ""}</span>
              <span style={{ color: tokenColor(l.t) }}>{l.s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Feature grid */}
      <div style={{ padding: "0 20px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {[
          { icon: "🔒", title: "Identity-locked", desc: "Your model. No bleed from other faces." },
          { icon: "⚡", title: "<2s generation", desc: "GPU-optimized HunyuanVideo pipeline." },
          { icon: "🖥", title: "Self-hostable", desc: "RunPod, bare metal, or on-prem GPU." },
          { icon: "🎙", title: "Voice matched", desc: "Cloned voice, synced lip movement." },
        ].map(f => (
          <div key={f.title} style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 8, padding: "12px" }}>
            <div style={{ fontSize: 16, marginBottom: 4 }}>{f.icon}</div>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 3 }}>{f.title}</div>
            <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.5 }}>{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
