// How cedarpad is put together, as of ADR-0023.
//
// The previous version of this card predated the edge Worker: it drew three tiers
// (browser / bridge / agent) and showed canvas writes landing in the bridge's memory. Four
// ADRs have moved since. What it draws now:
//
//   ADR-0018  the platform data layer is D1 at the EDGE; the container holds no db client
//   ADR-0019  the canvas document lives in a Durable Object, not in the bridge
//   ADR-0022  workspace content is Records in D1, not files on the container
//   ADR-0023  push planes split by volume and ownership — three of them, deliberately
//
// The three planes are the reason for the colour coding: they are the part of this system
// that is easiest to get wrong by adding "just one more" stream.

import { useEffect, useState } from 'react';

const C = {
  bg: '#0f1117',
  panel: '#1a1d27',
  border: '#2a2d3a',
  dim: '#1e2130',
  text: '#e2e8f0',
  muted: '#64748b',
  blue: '#4f9cf9', // browser surfaces
  teal: '#2dd4bf', // the edge
  violet: '#a78bfa', // durable objects
  orange: '#fb923c', // the container
  green: '#4ade80', // chat plane
  pink: '#f472b6', // storage
};

function Pulse({ color, delay = 0 }: { color: string; delay?: number }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    let run: ReturnType<typeof setInterval> | null = null;
    const id = setTimeout(() => {
      run = setInterval(() => setPhase((p) => (p + 1) % 3), 620);
    }, delay);
    return () => {
      clearTimeout(id);
      if (run) clearInterval(run);
    };
  }, [delay]);
  return (
    <span
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: phase === 0 ? color : phase === 1 ? `${color}aa` : `${color}44`,
        transition: 'background 0.4s ease',
        flexShrink: 0,
      }}
    />
  );
}

function Box({
  x,
  y,
  w,
  h,
  color,
  label,
  sublabel,
  chip,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  label: string;
  sublabel?: string;
  chip?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        background: C.dim,
        border: `1.5px solid ${color}44`,
        borderRadius: 10,
        boxSizing: 'border-box',
        padding: 9,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <div style={{ width: 3, height: 14, background: color, borderRadius: 2 }} />
        <span style={{ color, fontWeight: 700, fontSize: 10.5, letterSpacing: 0.4 }}>{label}</span>
        {chip && (
          <span
            style={{
              marginLeft: 'auto',
              background: `${color}22`,
              color,
              fontSize: 8,
              padding: '1px 6px',
              borderRadius: 99,
              border: `1px solid ${color}44`,
            }}
          >
            {chip}
          </span>
        )}
      </div>
      {sublabel && <div style={{ color: C.muted, fontSize: 8.5, marginBottom: 5, paddingLeft: 9, lineHeight: 1.35 }}>{sublabel}</div>}
      {children}
    </div>
  );
}

function Tag({ label, color, pulse, delay = 0 }: { label: string; color: string; pulse?: boolean; delay?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: `${color}18`,
        border: `1px solid ${color}44`,
        borderRadius: 6,
        padding: '2px 6px',
        marginBottom: 3.5,
      }}
    >
      {pulse && <Pulse color={color} delay={delay} />}
      <span style={{ color: C.text, fontSize: 9, fontFamily: 'ui-monospace, monospace' }}>{label}</span>
    </div>
  );
}

/** A dashed, animated edge. `dur` varies so several in view do not march in lockstep. */
function Flow({ d, color, label, lx, ly, dur = '0.9s' }: { d: string; color: string; label?: string; lx?: number; ly?: number; dur?: string }) {
  return (
    <>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="5 3" markerEnd={`url(#head-${color.slice(1)})`} opacity={0.75}>
        <animate attributeName="stroke-dashoffset" from="8" to="0" dur={dur} repeatCount="indefinite" />
      </path>
      {label && lx !== undefined && ly !== undefined && (
        <text x={lx} y={ly} fill={color} fontSize={8} fontFamily="ui-monospace, monospace" opacity={0.9} textAnchor="middle">
          {label}
        </text>
      )}
    </>
  );
}

export default function CanvasArch() {
  const W = 980;
  const H = 640;

  const rows = { browser: 34, edge: 196, dobj: 372, container: 512 };

  return (
    <div
      style={{
        width: W,
        height: H,
        background: C.bg,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 12,
      }}
    >
      <div style={{ position: 'absolute', left: 14, top: 8, color: C.text, fontSize: 12, fontWeight: 700, letterSpacing: 0.3 }}>
        cedarpad <span style={{ color: C.muted, fontWeight: 400 }}>— ADR-0018 / 0019 / 0022 / 0023</span>
      </div>

      {/* Tier rules + labels */}
      {(
        [
          ['BROWSER', rows.browser],
          ['EDGE WORKER · Cloudflare', rows.edge],
          ['DURABLE OBJECTS', rows.dobj],
          ['WORKSPACE CONTAINER · sleeps', rows.container],
        ] as const
      ).map(([label, y]) => (
        <div key={label}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: y - 10, height: 1, background: C.border }} />
          <div
            style={{
              position: 'absolute',
              right: 12,
              top: y - 8,
              color: C.muted,
              fontSize: 8.5,
              letterSpacing: 1,
            }}
          >
            {label}
          </div>
        </div>
      ))}

      {/* ---- Browser ---------------------------------------------------------- */}
      <Box x={16} y={rows.browser} w={230} h={140} color={C.blue} label="Shell SPA" chip="edge assets" sublabel="the one chrome; never wakes a container">
        <Tag label="Canvases · Components" color={C.blue} />
        <Tag label="Inbox · Jobs · Settings" color={C.blue} />
        <Tag label="iframes the Pad ↓" color={C.muted} />
      </Box>

      <Box x={262} y={rows.browser} w={264} h={140} color={C.blue} label="Render Pad" chip="container-served" sublabel="tldraw editor + chat cards">
        <Tag label="ComponentShape → loadComponent()" color={C.violet} pulse />
        <Tag label="ChatShape → chat-store" color={C.green} pulse delay={250} />
        <Tag label="pages: absent means the first" color={C.muted} />
      </Box>

      <Box x={542} y={rows.browser} w={200} h={140} color={C.pink} label="R2" chip="objects" sublabel="what D1 must not hold">
        <Tag label="canvas assets (images)" color={C.pink} />
        <Tag label="session transcripts" color={C.pink} />
        <Tag label="per-session, not per-workspace" color={C.muted} />
      </Box>

      {/* ---- Edge ------------------------------------------------------------- */}
      <Box x={16} y={rows.edge} w={286} h={152} color={C.teal} label="Platform data layer" chip="D1" sublabel="ADR-0018: the container holds no db client">
        <Tag label="workspaces · canvases · conversations" color={C.teal} />
        <Tag label="component_records + versions" color={C.teal} pulse />
        <Tag label="ADR-0022: content is Records, not files" color={C.muted} />
      </Box>

      <Box x={318} y={rows.edge} w={244} h={152} color={C.teal} label="Edge routes" sublabel="auth gate in front of everything">
        <Tag label="/api/components  (own→shared→base)" color={C.teal} />
        <Tag label="/api/workspace-components" color={C.teal} />
        <Tag label="/api/canvas-sync/:id/mutate" color={C.orange} />
        <Tag label="base manifest (bundled)" color={C.muted} />
      </Box>

      <Box x={578} y={rows.edge} w={164} h={152} color={C.teal} label="MCP server" chip="remote" sublabel="outside agents, full parity">
        <Tag label="read_canvas(page?)" color={C.blue} />
        <Tag label="place_component(page?)" color={C.violet} />
        <Tag label="write_component" color={C.violet} />
      </Box>

      <Box x={758} y={rows.edge} w={206} h={152} color={C.teal} label="Platform RPC" chip="HMAC bearer" sublabel="domain verbs, never a SQL tunnel">
        <Tag label="conversation.start / turn.end" color={C.teal} pulse delay={400} />
        <Tag label="the container's only way to write" color={C.muted} />
      </Box>

      {/* ---- Durable Objects --------------------------------------------------- */}
      <Box x={16} y={rows.dobj} w={286} h={120} color={C.violet} label="CanvasSyncRoom" chip="per canvas" sublabel="ADR-0019: the document lives here">
        <Tag label="TLSocketRoom · DO SQLite" color={C.violet} pulse />
        <Tag label="agent writes via updateStore()" color={C.orange} />
      </Box>

      <Box x={318} y={rows.dobj} w={244} h={120} color={C.violet} label="WorkspaceEvents" chip="per workspace" sublabel="ADR-0023: holds nothing, so cannot be wrong">
        <Tag label="topic only — subscriber re-reads D1" color={C.violet} pulse delay={300} />
        <Tag label="hibernating sockets · coalesced" color={C.muted} />
      </Box>

      <Box x={578} y={rows.dobj} w={386} h={120} color={C.violet} label="Sandbox / Warehouse" chip="per workspace" sublabel="compute containers — built to sleep, which is why the hub is not hung off one">
        <Tag label="cold boot on demand" color={C.orange} />
      </Box>

      {/* ---- Container --------------------------------------------------------- */}
      <Box x={16} y={rows.container} w={286} h={108} color={C.orange} label="Vite" sublabel="compiles every component, on demand">
        <Tag label="/src/canvas-<id>/components/*.tsx" color={C.violet} />
        <Tag label="materialized from Records" color={C.muted} />
      </Box>

      <Box x={318} y={rows.container} w={244} h={108} color={C.orange} label="Bridge" sublabel="no database client, by design">
        <Tag label="chat SSE hub" color={C.green} pulse />
        <Tag label="proxies canvas writes to the room" color={C.orange} />
      </Box>

      <Box x={578} y={rows.container} w={386} h={108} color={C.orange} label="Claude Agent SDK" chip="in-canvas chat" sublabel="its writes bind to the page its chat card sits on">
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <Tag label="read_canvas" color={C.blue} />
          <Tag label="create_shapes" color={C.orange} />
          <Tag label="write_component" color={C.violet} />
          <Tag label="place_component" color={C.violet} />
        </div>
      </Box>

      {/* ---- Flows ------------------------------------------------------------- */}
      <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
        <defs>
          {[C.blue, C.teal, C.violet, C.orange, C.green, C.pink].map((col) => (
            <marker key={col} id={`head-${col.slice(1)}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill={col} />
            </marker>
          ))}
        </defs>

        {/* PLANE 1 — tldraw sync: pad ⇄ its room. High volume, direct. */}
        <Flow d="M 300 174 L 150 372" color={C.violet} label="sync (WS)" lx={196} ly={286} dur="0.8s" />

        {/* PLANE 2 — the events hub: edge writes ring it, the Shell subscribes. */}
        <Flow d="M 440 348 L 130 174" color={C.violet} label="inbox notice" lx={300} ly={250} dur="1.1s" />

        {/* PLANE 3 — chat: turn output straight from the container. */}
        <Flow d="M 430 512 L 390 174" color={C.green} label="turn output (SSE)" lx={470} ly={340} dur="0.7s" />

        {/* Container → edge: the only write path it has. */}
        <Flow d="M 700 512 L 840 348" color={C.teal} label="RPC" lx={790} ly={440} dur="1.2s" />

        {/* Records → vite: a component is materialized, then compiled. */}
        <Flow d="M 120 348 L 120 512" color={C.teal} label="materialize" lx={166} ly={440} dur="1.0s" />
      </svg>

      {/* Legend — the three planes are the point (ADR-0023). */}
      <div style={{ position: 'absolute', bottom: 8, left: 16, display: 'flex', gap: 14, alignItems: 'center' }}>
        {[
          { color: C.violet, label: 'sync + hub (Durable Objects)' },
          { color: C.green, label: 'chat plane (container)' },
          { color: C.teal, label: 'edge / Records' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
            <span style={{ color: C.muted, fontSize: 8.5 }}>{label}</span>
          </div>
        ))}
        <span style={{ color: C.muted, fontSize: 8.5, marginLeft: 6 }}>
          three planes, split by volume and ownership — a new feature is never a reason for a fourth
        </span>
      </div>
    </div>
  );
}
