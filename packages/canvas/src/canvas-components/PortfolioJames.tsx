import { useState } from "react";

const colors = {
  bg: "#0a0a0f",
  surface: "#12121a",
  border: "#1e1e2e",
  accent: "#7c3aed",
  accentAlt: "#06b6d4",
  text: "#e2e8f0",
  muted: "#64748b",
  bright: "#f8fafc",
};

const projects = [
  {
    name: "Cloner",
    tag: "AI Product",
    tagColor: "#7c3aed",
    desc: "Reliable digital-twin video at scale. Identity-lock avatar models built on HunyuanVideo-Avatar — your face, your voice, any scene.",
    stack: ["HunyuanVideo", "Python", "CUDA", "3DGS"],
    status: "POC",
  },
  {
    name: "agent-canvas",
    tag: "Open Source",
    tagColor: "#06b6d4",
    desc: "tldraw canvas wired to Claude via MCP. Agents draw diagrams, build dashboards, and run workflows directly on a shared whiteboard.",
    stack: ["React", "tldraw", "Claude MCP", "Vite"],
    status: "Active",
  },
  {
    name: "CEO Agent",
    tag: "Infra",
    tagColor: "#f59e0b",
    desc: "Autonomous chief-of-staff agent running on a headless VM — email triage, scheduling, doc drafting, and business ops.",
    stack: ["Claude", "Playwright", "Cloudflare", "Node"],
    status: "Live",
  },
];

const skills = [
  { group: "AI / ML", items: ["LLM Orchestration", "Gaussian Splatting", "Video Diffusion", "MCP / Agent APIs"] },
  { group: "Infra", items: ["Cloudflare Workers", "Neon Postgres", "SOPS Secrets", "RunPod GPU"] },
  { group: "Frontend", items: ["React", "Vite", "tldraw", "TypeScript"] },
  { group: "Systems", items: ["Python", "CUDA", "Node.js", "Bash"] },
];

export default function PortfolioJames({ name = "James", title = "Builder & Founder", location = "Remote", email = "james@zabaca.com" }: {
  name?: string; title?: string; location?: string; email?: string;
}) {
  const [active, setActive] = useState<"about" | "projects" | "skills">("about");

  const navItems: Array<"about" | "projects" | "skills"> = ["about", "projects", "skills"];

  return (
    <div style={{ width: "100%", height: "100%", background: colors.bg, color: colors.text, fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Header */}
      <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.04em", color: colors.bright, lineHeight: 1.1 }}>
              {name}
            </div>
            <div style={{ fontSize: 12, color: colors.accentAlt, fontWeight: 600, marginTop: 3 }}>{title}</div>
            <div style={{ fontSize: 10, color: colors.muted, marginTop: 4, display: "flex", gap: 12 }}>
              <span>📍 {location}</span>
              <span>✉ {email}</span>
            </div>
          </div>
          {/* Avatar placeholder */}
          <div style={{
            width: 52, height: 52, borderRadius: "50%",
            background: `linear-gradient(135deg, ${colors.accent}, ${colors.accentAlt})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 20, fontWeight: 800, color: "#fff", flexShrink: 0,
          }}>
            {name[0]}
          </div>
        </div>

        {/* Nav */}
        <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${colors.border}`, marginLeft: -24, marginRight: -24, paddingLeft: 24 }}>
          {navItems.map(tab => (
            <button
              key={tab}
              onClick={() => setActive(tab)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "8px 14px", fontSize: 11, fontWeight: 600,
                color: active === tab ? colors.bright : colors.muted,
                borderBottom: active === tab ? `2px solid ${colors.accent}` : "2px solid transparent",
                textTransform: "capitalize", letterSpacing: "0.02em",
                marginBottom: -1, transition: "color 0.15s",
              }}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px 24px 24px" }}>

        {/* ABOUT */}
        {active === "about" && (
          <div>
            <p style={{ fontSize: 12, color: colors.text, lineHeight: 1.75, margin: "0 0 20px" }}>
              I build AI-native products and infrastructure at the intersection of media, identity, and automation. Currently focused on reliable digital-twin video and autonomous agent tooling.
            </p>

            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
              {[
                { label: "Projects live", value: "3" },
                { label: "Stack depth", value: "Full" },
                { label: "Focus", value: "AI" },
              ].map(s => (
                <div key={s.label} style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: colors.bright }}>{s.value}</div>
                  <div style={{ fontSize: 9, color: colors.muted, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Currently section */}
            <div style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: colors.accent, marginBottom: 10 }}>Currently</div>
              {[
                { icon: "🎬", text: "Building Cloner — digital-twin video POC" },
                { icon: "🤖", text: "Shipping agent-canvas MCP bridge" },
                { icon: "⚡", text: "Running CEO agent on headless VM" },
              ].map(item => (
                <div key={item.text} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8, fontSize: 11, color: colors.text, lineHeight: 1.5 }}>
                  <span style={{ fontSize: 13, flexShrink: 0 }}>{item.icon}</span>
                  {item.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PROJECTS */}
        {active === "projects" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {projects.map(p => (
              <div key={p.name} style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 12, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: colors.bright, marginRight: 8 }}>{p.name}</span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
                      background: p.tagColor + "22", color: p.tagColor, border: `1px solid ${p.tagColor}44`,
                    }}>{p.tag}</span>
                  </div>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
                    background: p.status === "Live" ? "#22c55e22" : p.status === "Active" ? "#06b6d422" : "#f59e0b22",
                    color: p.status === "Live" ? "#22c55e" : p.status === "Active" ? "#06b6d4" : "#f59e0b",
                    border: `1px solid ${p.status === "Live" ? "#22c55e44" : p.status === "Active" ? "#06b6d444" : "#f59e0b44"}`,
                  }}>{p.status}</span>
                </div>
                <p style={{ fontSize: 11, color: colors.muted, margin: "0 0 10px", lineHeight: 1.6 }}>{p.desc}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {p.stack.map(s => (
                    <span key={s} style={{
                      fontSize: 9, padding: "2px 7px", borderRadius: 6,
                      background: colors.border, color: colors.muted, fontFamily: "monospace",
                    }}>{s}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* SKILLS */}
        {active === "skills" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {skills.map(group => (
              <div key={group.group}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: colors.accent, marginBottom: 8 }}>{group.group}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {group.items.map(item => (
                    <span key={item} style={{
                      fontSize: 11, padding: "5px 12px", borderRadius: 99,
                      background: colors.surface, border: `1px solid ${colors.border}`,
                      color: colors.text, fontWeight: 500,
                    }}>{item}</span>
                  ))}
                </div>
              </div>
            ))}

            {/* Contact CTA */}
            <div style={{ marginTop: 8, background: `linear-gradient(135deg, ${colors.accent}22, ${colors.accentAlt}22)`, border: `1px solid ${colors.accent}44`, borderRadius: 12, padding: "16px", textAlign: "center" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: colors.bright, marginBottom: 4 }}>Let's build something</div>
              <div style={{ fontSize: 10, color: colors.muted, marginBottom: 12 }}>{email}</div>
              <button style={{
                background: `linear-gradient(135deg, ${colors.accent}, ${colors.accentAlt})`,
                color: "#fff", border: "none", borderRadius: 99,
                padding: "8px 20px", fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}>Get in touch →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
