import { useEffect, useState, useRef } from 'react';

const COLORS = {
  bg: '#0f1117',
  panel: '#1a1d27',
  border: '#2a2d3a',
  blue: '#4f9cf9',
  green: '#4ade80',
  violet: '#a78bfa',
  orange: '#fb923c',
  teal: '#2dd4bf',
  pink: '#f472b6',
  text: '#e2e8f0',
  muted: '#64748b',
  dim: '#1e2130',
};

function useLoop(ms: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

function Pulse({ color, size = 8, delay = 0 }: { color: string; size?: number; delay?: number }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => {
      const run = setInterval(() => setPhase(p => (p + 1) % 3), 600);
      return () => clearInterval(run);
    }, delay);
    return () => clearTimeout(id);
  }, [delay]);
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: phase === 0 ? color : phase === 1 ? color + 'aa' : color + '44',
      transition: 'background 0.4s ease',
      flexShrink: 0,
    }} />
  );
}

function FlowArrow({
  from, to, label, color = COLORS.blue, animate = true, vertical = false,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label?: string;
  color?: string;
  animate?: boolean;
  vertical?: boolean;
}) {
  const id = `arr-${from.x}-${from.y}-${to.x}-${to.y}`;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);

  return (
    <svg
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
    >
      <defs>
        <marker id={`head-${id}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={color} />
        </marker>
      </defs>
      <line
        x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={animate ? '6 4' : undefined}
        markerEnd={`url(#head-${id})`}
        opacity={0.7}
      >
        {animate && (
          <animate attributeName="stroke-dashoffset" from="10" to="0" dur="0.8s" repeatCount="indefinite" />
        )}
      </line>
      {label && (
        <text
          x={(from.x + to.x) / 2 + (vertical ? 6 : 0)}
          y={(from.y + to.y) / 2 + (vertical ? 0 : -5)}
          fill={color}
          fontSize="9"
          fontFamily="ui-monospace, monospace"
          opacity={0.85}
          textAnchor="middle"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

function Box({
  x, y, w, h, color, label, sublabel, chip, children,
}: {
  x: number; y: number; w: number; h: number;
  color: string; label: string; sublabel?: string; chip?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{
      position: 'absolute',
      left: x, top: y, width: w, height: h,
      background: COLORS.dim,
      border: `1.5px solid ${color}44`,
      borderRadius: 10,
      boxSizing: 'border-box',
      padding: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <div style={{ width: 3, height: 16, background: color, borderRadius: 2 }} />
        <span style={{ color, fontWeight: 700, fontSize: 11, letterSpacing: 0.5 }}>{label}</span>
        {chip && (
          <span style={{ marginLeft: 'auto', background: color + '22', color, fontSize: 8, padding: '1px 6px', borderRadius: 99, border: `1px solid ${color}44` }}>
            {chip}
          </span>
        )}
      </div>
      {sublabel && <div style={{ color: COLORS.muted, fontSize: 9, marginBottom: 6, paddingLeft: 9 }}>{sublabel}</div>}
      {children}
    </div>
  );
}

function Tag({ label, color, pulse, pulseDelay = 0 }: { label: string; color: string; pulse?: boolean; pulseDelay?: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      background: color + '18',
      border: `1px solid ${color}44`,
      borderRadius: 6,
      padding: '3px 7px',
      marginBottom: 4,
    }}>
      {pulse && <Pulse color={color} size={6} delay={pulseDelay} />}
      <span style={{ color: COLORS.text, fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>{label}</span>
    </div>
  );
}

const MESSAGES = [
  { text: 'draw me a chart of Q2 revenue', role: 'user' },
  { text: 'write_component KpiCard', role: 'tool' },
  { text: 'place_component x=200 y=150', role: 'tool' },
  { text: 'create_shapes [rectangle, text]', role: 'tool' },
  { text: 'Here\'s your Q2 chart!', role: 'agent' },
];

export default function CanvasArch() {
  const tick = useLoop(1400);
  const msgIdx = tick % MESSAGES.length;
  const msg = MESSAGES[msgIdx];
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(false);
    const t = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(t);
  }, [msgIdx]);

  const W = 920;
  const H = 580;

  // Layer positions
  const browserY = 30;
  const bridgeY = 250;
  const agentY = 430;

  // Boxes
  const tldrawBox = { x: 20, y: 30, w: 140, h: 200 };
  const chatBox = { x: 180, y: 30, w: 140, h: 120 };
  const componentBox = { x: 340, y: 30, w: 160, h: 120 };
  const storeBox = { x: 180, y: 170, w: 140, h: 90 };
  const loaderBox = { x: 340, y: 170, w: 160, h: 90 };
  const syncBox = { x: 520, y: 30, w: 180, h: 120 };
  const viteBox = { x: 720, y: 30, w: 170, h: 200 };
  const bridgeBox = { x: 20, y: 250, w: 560, h: 140 };
  const agentBox = { x: 20, y: 430, w: 360, h: 110 };
  const mcpBox = { x: 400, y: 430, w: 490, h: 110 };

  const arrowStyle = { pointerEvents: 'none' as const };

  return (
    <div style={{
      width: W,
      height: H,
      background: COLORS.bg,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      position: 'relative',
      overflow: 'hidden',
      borderRadius: 12,
    }}>

      {/* Layer labels */}
      <div style={{ position: 'absolute', right: 12, top: browserY + 2, color: COLORS.muted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>Browser · Vite/React</div>
      <div style={{ position: 'absolute', right: 12, top: bridgeY + 2, color: COLORS.muted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>Bridge · Node</div>
      <div style={{ position: 'absolute', right: 12, top: agentY + 2, color: COLORS.muted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>Agent · Claude SDK</div>

      {/* Horizontal dividers */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: bridgeY - 8, height: 1, background: COLORS.border }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: agentY - 8, height: 1, background: COLORS.border }} />

      {/* Tldraw box */}
      <Box x={tldrawBox.x} y={tldrawBox.y} w={tldrawBox.w} h={tldrawBox.h} color={COLORS.blue} label="Tldraw Editor">
        <Tag label="ChatShape" color={COLORS.green} pulse delay={0} />
        <Tag label="ComponentShape" color={COLORS.violet} pulse pulseDelay={300} />
        <Tag label="rectangle / ellipse" color={COLORS.blue} />
        <Tag label="arrow / text / note" color={COLORS.blue} />
      </Box>

      {/* Chat shape box */}
      <Box x={chatBox.x} y={chatBox.y} w={chatBox.w} h={chatBox.h} color={COLORS.green} label="ChatShapeUtil" chip="canvas shape">
        <Tag label="drag + resize" color={COLORS.muted} />
        <Tag label="HTMLContainer" color={COLORS.green} />
        <Tag label="guards kbd/wheel" color={COLORS.muted} />
      </Box>

      {/* Component shape box */}
      <Box x={componentBox.x} y={componentBox.y} w={componentBox.w} h={componentBox.h} color={COLORS.violet} label="ComponentShapeUtil" chip="canvas shape">
        <Tag label="dynamic import" color={COLORS.violet} pulse pulseDelay={200} />
        <Tag label="module + data + rev" color={COLORS.muted} />
        <Tag label="ErrorBoundary" color={COLORS.orange} />
      </Box>

      {/* chat-store */}
      <Box x={storeBox.x} y={storeBox.y} w={storeBox.w} h={storeBox.h} color={COLORS.green} label="chat-store.ts" sublabel="singleton — survives cull">
        <Tag label="SSE streams" color={COLORS.green} pulse />
        <Tag label="localStorage" color={COLORS.muted} />
      </Box>

      {/* component-loader */}
      <Box x={loaderBox.x} y={loaderBox.y} w={loaderBox.w} h={loaderBox.h} color={COLORS.violet} label="component-loader.ts" sublabel="retry + cache">
        <Tag label="/src/canvas-components/*.tsx" color={COLORS.violet} />
        <Tag label="rev cache-bust" color={COLORS.muted} />
      </Box>

      {/* sync.ts */}
      <Box x={syncBox.x} y={syncBox.y} w={syncBox.w} h={syncBox.h} color={COLORS.teal} label="sync.ts · wireSync()" chip="bi-directional">
        <Tag label="SSE → mergeRemoteChanges" color={COLORS.teal} pulse />
        <Tag label="user edits → POST (80ms)" color={COLORS.orange} />
        <Tag label="screenshot → POST /canvas/screenshot" color={COLORS.muted} />
      </Box>

      {/* vite */}
      <Box x={viteBox.x} y={viteBox.y} w={viteBox.w} h={viteBox.h} color={COLORS.orange} label="Vite Dev Server" sublabel="compiles canvas-components">
        <Tag label="hot module reload" color={COLORS.orange} />
        <Tag label="/src/canvas-components/" color={COLORS.muted} />
        <Tag label="import(url?v=rev)" color={COLORS.violet} />
        <Tag label="proxy /api → bridge" color={COLORS.teal} />
      </Box>

      {/* Bridge */}
      <Box x={bridgeBox.x} y={bridgeBox.y} w={bridgeBox.w} h={bridgeBox.h} color={COLORS.teal} label="Bridge Server">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Tag label="GET /api/canvas/stream (SSE)" color={COLORS.teal} pulse />
          <Tag label="POST /api/canvas/shapes" color={COLORS.orange} />
          <Tag label="POST /api/canvas/delete" color={COLORS.orange} />
          <Tag label="POST /api/canvas/screenshot" color={COLORS.orange} />
          <Tag label="GET /api/chat/stream (SSE, all chats)" color={COLORS.green} pulse pulseDelay={400} />
          <Tag label="POST /api/chat/:id/send" color={COLORS.orange} />
        </div>
        <div style={{ marginTop: 4, color: COLORS.muted, fontSize: 9 }}>in-memory CanvasState (version + shapes[] + pages[]) · canvas persisted to a JSON file · chat transcript derived from the SDK session JSONL (server-owned ChatMeta)</div>
      </Box>

      {/* Agent */}
      <Box x={agentBox.x} y={agentBox.y} w={agentBox.w} h={agentBox.h} color={COLORS.pink} label="Claude Agent (SDK)" sublabel="claude-sonnet-5">
        <div style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: '5px 8px',
          minHeight: 36,
          transition: 'opacity 0.15s',
          opacity: visible ? 1 : 0,
        }}>
          <span style={{
            fontSize: 9,
            color: msg.role === 'user' ? COLORS.blue : msg.role === 'tool' ? COLORS.orange : COLORS.green,
            fontFamily: 'ui-monospace, monospace',
          }}>
            [{msg.role}] {msg.text}
          </span>
        </div>
      </Box>

      {/* MCP tools */}
      <Box x={mcpBox.x} y={mcpBox.y} w={mcpBox.w} h={mcpBox.h} color={COLORS.orange} label="MCP Canvas Tools" chip="Claude Code">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Tag label="create_shapes" color={COLORS.orange} />
          <Tag label="update_shapes" color={COLORS.orange} />
          <Tag label="delete_shapes" color={COLORS.orange} />
          <Tag label="write_component" color={COLORS.violet} pulse />
          <Tag label="place_component" color={COLORS.violet} />
          <Tag label="read_canvas" color={COLORS.blue} />
          <Tag label="view_canvas" color={COLORS.blue} />
        </div>
      </Box>

      {/* SVG arrows overlay */}
      <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
        <defs>
          {['blue','green','violet','teal','orange','pink'].map(c => {
            const col = (COLORS as Record<string,string>)[c];
            return (
              <marker key={c} id={`arrow-${c}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill={col} />
              </marker>
            );
          })}
        </defs>

        {/* ChatShape <-> chat-store */}
        <line x1={250} y1={150} x2={250} y2={170} stroke={COLORS.green} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-green)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.7s" repeatCount="indefinite" />
        </line>
        <text x={256} y={163} fill={COLORS.green} fontSize={8} fontFamily="ui-monospace">subscribe</text>

        {/* ComponentShape <-> component-loader */}
        <line x1={420} y1={150} x2={420} y2={170} stroke={COLORS.violet} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-violet)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.9s" repeatCount="indefinite" />
        </line>
        <text x={428} y={163} fill={COLORS.violet} fontSize={8} fontFamily="ui-monospace">loadComponent</text>

        {/* component-loader -> Vite */}
        <line x1={500} y1={215} x2={720} y2={130} stroke={COLORS.violet} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-violet)" opacity={0.6}>
          <animate attributeName="stroke-dashoffset" from="9" to="0" dur="1.1s" repeatCount="indefinite" />
        </line>
        <text x={610} y={155} fill={COLORS.violet} fontSize={8} fontFamily="ui-monospace">dynamic import</text>

        {/* sync.ts -> Bridge (SSE in) */}
        <line x1={560} y1={150} x2={400} y2={250} stroke={COLORS.teal} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-teal)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.8s" repeatCount="indefinite" />
        </line>
        <text x={450} y={195} fill={COLORS.teal} fontSize={8} fontFamily="ui-monospace">SSE stream</text>

        {/* sync.ts -> Bridge (POST) */}
        <line x1={620} y1={150} x2={420} y2={250} stroke={COLORS.orange} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-orange)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.2s" repeatCount="indefinite" />
        </line>
        <text x={565} y={215} fill={COLORS.orange} fontSize={8} fontFamily="ui-monospace">POST shapes</text>

        {/* chat-store -> Bridge SSE */}
        <line x1={250} y1={260} x2={250} y2={250} stroke={COLORS.green} strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arrow-green)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="7" to="0" dur="0.7s" repeatCount="indefinite" />
        </line>

        {/* Bridge <-> Agent */}
        <line x1={200} y1={390} x2={200} y2={430} stroke={COLORS.pink} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-pink)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.9s" repeatCount="indefinite" />
        </line>
        <text x={208} y={415} fill={COLORS.pink} fontSize={8} fontFamily="ui-monospace">SSE events</text>

        {/* MCP tools -> Bridge POST */}
        <line x1={550} y1={430} x2={400} y2={390} stroke={COLORS.orange} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-orange)" opacity={0.7}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.0s" repeatCount="indefinite" />
        </line>
        <text x={460} y={408} fill={COLORS.orange} fontSize={8} fontFamily="ui-monospace">canvas ops</text>

        {/* MCP write_component -> Vite */}
        <line x1={720} y1={470} x2={805} y2={230} stroke={COLORS.violet} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-violet)" opacity={0.6}>
          <animate attributeName="stroke-dashoffset" from="9" to="0" dur="1.3s" repeatCount="indefinite" />
        </line>
        <text x={785} y={360} fill={COLORS.violet} fontSize={8} fontFamily="ui-monospace">write file</text>

        {/* Agent <-> MCP */}
        <line x1={380} y1={480} x2={400} y2={480} stroke={COLORS.orange} strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arrow-orange)" opacity={0.8}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.6s" repeatCount="indefinite" />
        </line>
        <text x={385} y={473} fill={COLORS.orange} fontSize={8} fontFamily="ui-monospace">tool calls</text>

        {/* Tldraw <-> sync */}
        <line x1={160} y1={130} x2={520} y2={80} stroke={COLORS.blue} strokeWidth={1.5} strokeDasharray="5 3" markerEnd="url(#arrow-blue)" opacity={0.5}>
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1.0s" repeatCount="indefinite" />
        </line>
        <text x={330} y={88} fill={COLORS.blue} fontSize={8} fontFamily="ui-monospace">store.listen / mergeRemoteChanges</text>
      </svg>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 8, right: 8,
        display: 'flex', gap: 10, alignItems: 'center',
      }}>
        {[
          { color: COLORS.green, label: 'Chat flow' },
          { color: COLORS.violet, label: 'Component flow' },
          { color: COLORS.teal, label: 'Canvas sync' },
          { color: COLORS.orange, label: 'MCP / POST' },
          { color: COLORS.pink, label: 'Agent' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
            <span style={{ color: COLORS.muted, fontSize: 8 }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
