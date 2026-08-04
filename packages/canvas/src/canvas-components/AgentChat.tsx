// Agent-terminal chat. Renders a coding-agent transcript in the visual grammar of Claude
// Code, Codex CLI, or Grok CLI — header, turns, working line, tool calls, diffs, todos,
// events, thoughts, writes, permission prompts — with a working composer and slash menu.
//
// The grammar is ported from the `brainless` shadcn registry (brainless.swerdlow.dev),
// which rebuilds those three terminal UIs as semantic React. That registry is Tailwind-
// classed and installs via `shadcn add`; canvas components must be self-contained with
// inline styles (no Tailwind here, ADR-0014 base tier), so this is a PORT, not an install.
// What carries over verbatim is the part that matters — the palettes, glyph grammar
// (⏺ ⎿ ❯ › • ◆ ┃ ✔ ◼ ◻), and the semantics: <details> for tool output, aria-live on the
// working line, listbox/option on the slash menu, real list and radio roles, off-screen
// added/removed labels on diff rows.
//
// One deliberate deviation: brainless drives disclosure with a bare <summary>, permission
// options with role="radio" divs, and slash rows with <li onMouseEnter>. None survives
// ComponentShape's capture-phase pointer guard (src/predicates.ts admits only button/input/
// textarea/select/a/label/[contenteditable]/[role="button"]), so tldraw would claim the
// pointer and the browser would never synthesize a click. Every control here is a real
// <button> or carries role="button" — the one change without which this card would look
// right and do nothing.
//
// Covered from the registry: all of claude-session and codex-session, and grok-session /
// grok-session-active except its project picker, shortcuts and settings panes (which are
// launcher chrome, not transcript). Codex's own diff and permission variants still share
// the Claude renderings.
//
// The composer is a UI, not a wire: sending appends the turn and a scripted reply that
// exercises the block vocabulary. Nothing here talks to an agent.
import { useEffect, useRef, useState } from 'react';

type Skin = 'claude' | 'codex' | 'grok';
type ToolStatus = 'success' | 'error' | 'pending';
type DiffLine = { type: 'add' | 'del' | 'ctx'; n?: number; text: string };
type Todo = { label: string; status: 'done' | 'active' | 'todo' };
type WriteLine = { n?: number; text: string };
type HookResult = { label: string; ok: boolean; detail?: string; ms?: number };

type Entry =
  | { kind: 'user'; text: string; time?: string }
  | { kind: 'assistant'; text: string; time?: string }
  | { kind: 'notice'; text: string; tone?: 'warn' | 'ok' | 'dim' }
  | { kind: 'todo'; todos: Todo[] }
  | { kind: 'tool'; tool: string; arg?: string; result: string; status?: ToolStatus; output?: string; variant?: 'line' | 'card'; hooks?: number }
  | { kind: 'diff'; file: string; summary?: string; lines: DiffLine[] }
  | { kind: 'write'; before: WriteLine[]; after: WriteLine[]; hooks?: HookResult[] }
  | { kind: 'event'; label: string; elapsed?: string; hooks?: number; hooksOk?: number }
  | { kind: 'thought'; elapsed?: string; body?: string }
  | { kind: 'permission'; title?: string; command: string; question?: string; options?: string[] }
  | { kind: 'plan'; file?: string; lines: string[] }
  | { kind: 'thinking'; variant?: 'idle' | 'working'; label?: string; tokens?: string }
  | { kind: 'turn-end'; elapsed: string };

// Per-skin palettes, read off the brainless sources (which read them off real terminal
// captures). `accent` is the brand hue, `link` the path/command hue.
const SKINS: Record<
  Skin,
  {
    label: string;
    bg: string;
    fg: string;
    muted: string;
    dim: string;
    accent: string;
    link: string;
    ok: string;
    err: string;
    warn: string;
    caret: string;
    /** Gutter/rule color for the `┃`-bordered Grok blocks. */
    rule: string;
    /** The user-turn marker, and whether it paints a full-width row (Claude does). */
    marker: string;
    markerRow?: string;
  }
> = {
  claude: {
    label: 'Claude Code',
    bg: '#181818',
    fg: '#c0caf5',
    muted: '#8b8fa3',
    dim: '#565f89',
    accent: '#cd694a',
    link: '#7dcfff',
    ok: '#4ea96f',
    err: '#f7768e',
    warn: '#e0af68',
    caret: '#c0caf5',
    rule: '#565f89',
    marker: '❯',
    markerRow: '#3a3a3a',
  },
  codex: {
    label: 'OpenAI Codex',
    bg: '#1a1a1a',
    fg: '#ededed',
    muted: '#c9c9c9',
    dim: '#7a7a7a',
    accent: '#5cc2e0',
    link: '#5cc2e0',
    ok: '#4ea96f',
    err: '#f7768e',
    warn: '#e0af68',
    caret: '#ededed',
    rule: '#3a3a3a',
    marker: '›',
  },
  grok: {
    label: 'Grok CLI',
    bg: '#1a1a1a',
    fg: '#e1e1e1',
    muted: '#cfcfd2',
    dim: '#6c6c6c',
    accent: '#e0af68',
    link: '#8db0ff',
    ok: '#00ff00',
    err: '#ff0000',
    warn: '#ffff00',
    caret: '#e1e1e1',
    rule: '#808080',
    marker: '❯',
  },
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// The default transcript deliberately exercises every entry kind once — it is the
// showcase as much as it is sample data.
const DEFAULT_TRANSCRIPT: Entry[] = [
  { kind: 'notice', text: '⚠ 3 MCP servers need authentication · run /mcp', tone: 'warn' },
  { kind: 'user', text: 'add a dark-mode toggle to the settings page and run the tests', time: '4:38 PM' },
  { kind: 'event', label: 'user_prompt_submit', hooks: 3, hooksOk: 1 },
  { kind: 'thought', elapsed: '0.2s', body: 'The settings panel already takes a header slot, so the toggle can go there without touching layout.' },
  { kind: 'assistant', text: "I'll add the toggle, wire it into the theme provider, then run the suite." },
  {
    kind: 'todo',
    todos: [
      { label: 'Read the settings page', status: 'done' },
      { label: 'Add the dark-mode toggle', status: 'active' },
      { label: 'Run the test suite', status: 'todo' },
    ],
  },
  { kind: 'tool', tool: 'Read', arg: 'app/settings/page.tsx', result: 'Read 48 lines' },
  { kind: 'tool', tool: 'Write', arg: 'app/settings/theme-toggle.tsx', result: 'created', variant: 'card', hooks: 3 },
  {
    kind: 'write',
    before: [{ n: 1, text: 'export const theme = "light"' }],
    after: [{ n: 1, text: 'export const theme = stored() ?? "system"' }],
    hooks: [
      { label: 'format', ok: true, ms: 42 },
      { label: 'typecheck', ok: false, detail: 'stored() is not exported', ms: 810 },
    ],
  },
  {
    kind: 'diff',
    file: 'app/settings/page.tsx',
    summary: 'Updated app/settings/page.tsx with 3 additions and 1 removal',
    lines: [
      { type: 'ctx', n: 11, text: 'export function Settings() {' },
      { type: 'del', n: 12, text: '  return <Panel>{sections}</Panel>' },
      { type: 'add', n: 12, text: '  return (' },
      { type: 'add', n: 13, text: '    <Panel header={<ThemeToggle />}>' },
      { type: 'add', n: 14, text: '      {sections}' },
      { type: 'ctx', n: 15, text: '    </Panel>' },
    ],
  },
  {
    kind: 'tool',
    tool: 'Bash',
    arg: 'bun test',
    result: '12 passed, 0 failed in 1.4s',
    output: 'bun test v1.2.21\n✓ settings > renders the theme toggle\n✓ theme > persists across reloads\n 12 pass\n 0 fail',
  },
  { kind: 'tool', tool: 'Grep', arg: 'useTheme', result: 'no matches', status: 'error' },
  {
    kind: 'plan',
    file: 'plan.md',
    lines: [
      'Plan: dark-mode toggle',
      '',
      '1. Add ThemeToggle to the settings panel header.',
      '2. Read the stored preference on mount.',
      '3. Cover both in the settings test.',
    ],
  },
  { kind: 'permission', title: 'Bash command', command: "git commit -am 'Add dark-mode toggle'" },
  { kind: 'thinking', variant: 'working', label: 'Waiting for response…', tokens: '16.6k' },
];

/* ── slash commands ─────────────────────────────────────────────────────── */

type SlashCommand = { name: string; description: string };

const SLASH: Record<Skin, SlashCommand[]> = {
  claude: [
    { name: '/agents', description: 'Manage subagents for specialized tasks' },
    { name: '/clear', description: 'Clear conversation history and free up context' },
    { name: '/compact', description: 'Summarize the conversation to save context' },
    { name: '/init', description: 'Initialize a CLAUDE.md with codebase docs' },
    { name: '/model', description: 'Change the model for this session' },
    { name: '/review', description: 'Review a pull request' },
  ],
  codex: [
    { name: '/model', description: 'choose what model and reasoning effort to use' },
    { name: '/permissions', description: 'choose what Codex is allowed to do' },
    { name: '/diff', description: 'show the unified diff for this session' },
    { name: '/review', description: 'review a pull request or local changes' },
    { name: '/status', description: 'show model, limits, and session info' },
    { name: '/compact', description: 'summarize the conversation to save context' },
  ],
  grok: [
    { name: '/quit', description: 'Quit the application' },
    { name: '/help', description: 'Browse commands and keyboard shortcuts' },
    { name: '/docs', description: 'Open How-to Guides or online Build docs' },
    { name: '/home', description: 'Return to the welcome screen' },
    { name: '/new', description: 'Start a new session' },
    { name: '/fork', description: 'Branch the current session into a peer agent' },
  ],
};

/** The commands a draft beginning with `/` matches, by name prefix. Empty when not slashing. */
export function slashMatches(skin: Skin, draft: string): SlashCommand[] {
  if (!draft.startsWith('/')) return [];
  const q = draft.slice(1).toLowerCase();
  return (SLASH[skin] ?? []).filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
}

/* ── the card ───────────────────────────────────────────────────────────── */

export default function AgentChat({
  skin: skinProp = 'claude',
  title,
  model,
  cwd = '~/dev/acme-app',
  branch = 'main',
  transcript = DEFAULT_TRANSCRIPT,
  setData,
}: {
  skin?: Skin;
  title?: string;
  model?: string;
  cwd?: string;
  branch?: string;
  transcript?: Entry[];
  setData?: (patch: { skin?: Skin; transcript?: Entry[] }) => void;
}) {
  const skin = SKINS[skinProp] ? skinProp : 'claude';
  const c = SKINS[skin];
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom as turns arrive. NEVER scrollIntoView: this card lives inside
  // tldraw's CSS-scale transform, which that API computes through wrongly and which can
  // yank ancestor scrollers. Scrolling our own container is pure layout.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const send = () => {
    const next = appendTurn(transcript, draft, cwd);
    if (!next) return;
    setDraft('');
    setData?.({ transcript: next });
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        background: c.bg,
        color: c.fg,
        fontFamily: MONO,
        fontSize: 13,
        lineHeight: 1.55,
        overflow: 'hidden',
      }}
    >
      <Shimmer />
      <SkinBar skin={skin} onPick={(s) => setData?.({ skin: s })} />

      <div ref={logRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px' }}>
        <Header skin={skin} title={title} model={model} cwd={cwd} branch={branch} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>
          {transcript.map((e, i) => (
            <Block key={i} entry={e} skin={skin} />
          ))}
        </div>
      </div>

      <Composer skin={skin} value={draft} onChange={setDraft} onSend={send} model={model} cwd={cwd} />
    </div>
  );
}

const clock = () =>
  new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * The transcript after sending `text`, or null when there is nothing to send.
 *
 * Exported and pure because it cannot be driven through the DOM in tests: happy-dom
 * defines `value` as an own property on the element, which makes React skip installing a
 * real value tracker, so a controlled input's onChange never fires under that harness no
 * matter how the event is dispatched. The behavior worth pinning is this function's.
 *
 * The trailing working line is dropped and re-appended so it always trails the transcript
 * — an agent is not still thinking about the turn you just replaced.
 */
export function appendTurn(transcript: Entry[], text: string, cwd: string): Entry[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return [
    ...transcript.filter((e) => e.kind !== 'thinking'),
    { kind: 'user', text: trimmed, time: clock() },
    { kind: 'assistant', text: `On it — ${trimmed.replace(/\.$/, '')}.` },
    { kind: 'tool', tool: 'Read', arg: `${cwd.replace(/^~\//, '')}/README.md`, result: 'Read 24 lines' },
    { kind: 'thinking' },
  ];
}

/* ── chrome ─────────────────────────────────────────────────────────────── */

// The working lines shimmer: Claude drifts a lighter terracotta highlight across the verb,
// Codex sweeps a bright grayscale band across "Working". Both use background-clip: text so
// the DOM text stays selectable and announced — a canvas or image would not be. Injected as
// a real <style> because keyframes cannot be expressed as inline styles.
const CLAUDE_BASE = '#cd694a';
const CLAUDE_HILITE = '#e79475';

function Shimmer() {
  return (
    <style>{`
      .ac-shine {
        background-size: 200% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        -webkit-text-fill-color: transparent;
        animation: ac-shine 2.8s linear infinite;
      }
      .ac-shine-claude {
        background-image: linear-gradient(100deg, ${CLAUDE_BASE} 43%, ${CLAUDE_HILITE} 50%, ${CLAUDE_BASE} 57%);
      }
      .ac-shine-codex {
        background-image: linear-gradient(90deg, #808080 0%, #808080 40%, #e7e7e7 50%, #808080 60%, #808080 100%);
        animation-duration: 1.6s;
      }
      @keyframes ac-shine {
        from { background-position: 100% 0; }
        to   { background-position: -100% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ac-shine { animation: none; background-image: none; -webkit-text-fill-color: currentColor; color: inherit; }
      }
    `}</style>
  );
}

// Skin switcher. Left-aligned on purpose: the top-RIGHT corner of a component shape is
// reserved for the host's hover-revealed fullscreen button.
function SkinBar({ skin, onPick }: { skin: Skin; onPick: (s: Skin) => void }) {
  const c = SKINS[skin];
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        padding: '6px 8px',
        borderBottom: `1px solid ${c.dim}44`,
        background: '#0d1017',
        flexShrink: 0,
      }}
    >
      {(Object.keys(SKINS) as Skin[]).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          style={{
            font: 'inherit',
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 4,
            cursor: 'pointer',
            border: `1px solid ${s === skin ? SKINS[s].accent : 'transparent'}`,
            background: s === skin ? `${SKINS[s].accent}22` : 'transparent',
            color: s === skin ? SKINS[s].accent : '#7a7f8c',
          }}
        >
          {SKINS[s].label}
        </button>
      ))}
    </div>
  );
}

function Header({
  skin,
  title,
  model,
  cwd,
  branch,
}: {
  skin: Skin;
  title?: string;
  model?: string;
  cwd: string;
  branch: string;
}) {
  const c = SKINS[skin];

  if (skin === 'claude') {
    return (
      <fieldset style={{ border: `1px solid ${c.accent}`, borderRadius: 6, padding: '2px 14px 12px', margin: 0, minWidth: 0 }}>
        <legend style={{ color: c.accent, padding: '0 8px' }}>
          {title ?? 'Claude Code'} <span style={{ color: '#949494' }}>v2.1.206</span>
        </legend>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 180 }}>
            <div style={{ fontWeight: 600 }}>Welcome back!</div>
            <Sprite bits={CLAUDE_LOGO} color={c.accent} scale={3} pixelHeight={2.4} />
            <div style={{ color: '#949494', textAlign: 'center' }}>
              <div>{model ?? 'Opus 5 · Claude Max'}</div>
              <div>{cwd}</div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ color: c.accent, fontWeight: 600 }}>Tips for getting started</div>
            <div>Ask Claude to create a new app or clone a repo</div>
            <div style={{ height: 1, background: c.accent, margin: '6px 0' }} />
            <div style={{ color: c.accent, fontWeight: 600 }}>What&apos;s new</div>
            <div>Added directory path suggestions to /cd</div>
            <div style={{ color: '#949494', fontStyle: 'italic' }}>/release-notes for more</div>
          </div>
        </div>
      </fieldset>
    );
  }

  if (skin === 'codex') {
    return (
      <div style={{ border: '1px solid #3a3a3a', borderRadius: 6, padding: '10px 14px', lineHeight: 1.7 }}>
        <div>
          <span aria-hidden style={{ color: c.dim }}>{'>_ '}</span>
          <span style={{ fontWeight: 500 }}>{title ?? 'OpenAI Codex'}</span>{' '}
          <span style={{ color: c.dim }}>(v0.132.0)</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', columnGap: 12, marginTop: 6 }}>
          <span style={{ color: c.dim }}>model:</span>
          <span>
            {model ?? 'gpt-5.6-sol low'} <span style={{ color: c.link, marginLeft: 8 }}>/model</span>{' '}
            <span style={{ color: c.dim }}>to change</span>
          </span>
          <span style={{ color: c.dim }}>directory:</span>
          <span>{cwd}</span>
        </div>
      </div>
    );
  }

  // Grok shows BOTH: the launch card with the braille mark, then the status bar.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, border: `1px solid ${c.rule}`, borderRadius: 4, padding: '10px 14px' }}>
        <Sprite bits={GROK_LOGO} color={c.accent} scale={1.6} pixelHeight={1} dotted />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{title ?? 'Grok CLI'}</div>
          <div style={{ color: '#8b8b90' }}>{model ?? 'Grok 4.5 (xhigh)'}</div>
          <div style={{ color: '#8b8b90' }}>{cwd}</div>
        </div>
      </div>
      <div
        role="status"
        aria-label="Session status"
        style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', fontSize: 12, color: '#8b8b90' }}
      >
        <span>
          <span style={{ color: '#e1e1e1' }}>{branch}</span> <span>{cwd}</span>
        </span>
        <span>
          16K<span style={{ color: c.dim }}> / </span>500K <span style={{ color: c.dim }}>│</span> 2/3{' '}
          <span style={{ color: c.ok }}>✓</span>
        </span>
      </div>
    </div>
  );
}

// Claude Code's launch sprite and Grok's braille mark as 1-bit bitmaps, drawn as crisp SVG
// (brainless does the same, and for the same reason: block/braille glyphs seam at any font
// size). Grok renders each dot spaced rather than filled, which `dotted` reproduces.
const CLAUDE_LOGO: [string, ...string[]] = [
  '000111111111111000',
  '000110111111011000',
  '011111111111111110',
  '000111111111111000',
  '000010100001010000',
];

const GROK_LOGO: [string, ...string[]] = [
  '00000000000000000000000001',
  '00000000000111110000000010',
  '00000000111111111110000100',
  '00000001111111111110001000',
  '00000011111000000000011000',
  '00000111100000000000110000',
  '00001111000000000001111000',
  '00001110000000000011111000',
  '00011100000000000110111000',
  '00011100000000001100011100',
  '00011100000000010000011100',
  '00011100000000100000011100',
  '00011100000001000000011100',
  '00011100000000000000011100',
  '00011100000000000000011000',
  '00001110000000000000111000',
  '00001110000000000001111000',
  '00001110000000000011110000',
  '00001100000000000111100000',
  '00011000011111111111000000',
  '00010000111111111110000000',
  '00100000001111111000000000',
  '01000000000000000000000000',
  '10000000000000000000000000',
];

function Sprite({
  bits,
  color,
  scale,
  pixelHeight,
  dotted = false,
}: {
  bits: [string, ...string[]];
  color: string;
  scale: number;
  pixelHeight: number;
  dotted?: boolean;
}) {
  const w = bits[0].length;
  const h = bits.length;
  const cells: React.ReactElement[] = [];

  bits.forEach((row, y) => {
    if (dotted) {
      // One spaced dot per set bit — Grok's mark is drawn as separate braille dots.
      for (let x = 0; x < w; x++) {
        if (row[x] === '1') cells.push(<circle key={`${x}-${y}`} cx={x + 0.5} cy={y * pixelHeight + pixelHeight / 2} r={0.26} />);
      }
      return;
    }
    // Runs of set bits become one rect — fewer nodes, and no seams between neighbours.
    let x = 0;
    while (x < w) {
      if (row[x] === '1') {
        let end = x;
        while (end < w && row[end] === '1') end += 1;
        cells.push(<rect key={`${x}-${y}`} x={x} y={y * pixelHeight} width={end - x} height={pixelHeight} />);
        x = end;
      } else x += 1;
    }
  });

  return (
    <svg
      aria-hidden
      width={w * scale}
      height={h * pixelHeight * scale}
      viewBox={`0 0 ${w} ${h * pixelHeight}`}
      shapeRendering={dotted ? 'auto' : 'crispEdges'}
      fill={color}
      style={{ flexShrink: 0 }}
    >
      {cells}
    </svg>
  );
}

/* ── transcript blocks ──────────────────────────────────────────────────── */

function Block({ entry, skin }: { entry: Entry; skin: Skin }) {
  const c = SKINS[skin];

  switch (entry.kind) {
    case 'user':
      return skin === 'claude' ? (
        <div style={{ display: 'flex', alignItems: 'baseline', background: c.markerRow, minWidth: 0 }}>
          <span aria-hidden style={{ color: '#4e4e4e', flexShrink: 0 }}>
            {c.marker}
          </span>
          <span aria-hidden style={{ display: 'inline-block', width: '1ch', flexShrink: 0 }} />
          <span style={{ color: '#fff', minWidth: 0, flex: 1, overflowWrap: 'break-word' }}>{entry.text}</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <span aria-hidden style={{ flexShrink: 0, fontWeight: skin === 'codex' ? 700 : 400 }}>
            {c.marker}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'break-word' }}>{entry.text}</span>
          {entry.time ? <span style={{ color: c.dim, flexShrink: 0 }}>{entry.time}</span> : null}
        </div>
      );

    case 'assistant':
      return (
        <div style={{ color: skin === 'claude' ? c.fg : c.muted, overflowWrap: 'break-word' }}>{entry.text}</div>
      );

    case 'notice':
      return (
        <div style={{ color: entry.tone === 'ok' ? c.ok : entry.tone === 'dim' ? c.dim : c.warn }}>{entry.text}</div>
      );

    case 'todo':
      return <TodoList todos={entry.todos} skin={skin} />;

    case 'tool':
      return entry.variant === 'card' ? <ToolCard entry={entry} skin={skin} /> : <ToolCall entry={entry} skin={skin} />;

    case 'diff':
      return <Diff entry={entry} skin={skin} />;

    case 'write':
      return <Write entry={entry} skin={skin} />;

    case 'event':
      return <EventLine entry={entry} skin={skin} />;

    case 'thought':
      return <Thought entry={entry} skin={skin} />;

    case 'permission':
      return skin === 'grok' ? <GrokPermission entry={entry} skin={skin} /> : <Permission entry={entry} skin={skin} />;

    case 'plan':
      return <Plan entry={entry} skin={skin} />;

    case 'thinking':
      return <Thinking skin={skin} entry={entry} />;

    case 'turn-end':
      return <div style={{ color: c.muted }}>Turn completed in {entry.elapsed}.</div>;
  }
}

const TODO_ICON = { done: '✔', active: '◼', todo: '◻' } as const;

function TodoList({ todos, skin }: { todos: Todo[]; skin: Skin }) {
  const c = SKINS[skin];
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {todos.map((t, i) => (
        <li key={i} style={{ whiteSpace: 'pre' }}>
          <span aria-hidden style={{ color: c.dim }}>
            {i === 0 ? '  ⎿ ' : '    '}
          </span>
          <span aria-hidden style={{ color: t.status === 'done' ? '#87d787' : t.status === 'active' ? c.accent : undefined }}>
            {TODO_ICON[t.status]}{' '}
          </span>
          <span
            style={{
              color: t.status === 'done' ? '#949494' : undefined,
              textDecoration: t.status === 'done' ? 'line-through' : undefined,
              fontWeight: t.status === 'active' ? 600 : undefined,
            }}
          >
            {t.label}
            <span style={SR_ONLY}>
              {' '}
              ({t.status === 'done' ? 'completed' : t.status === 'active' ? 'in progress' : 'pending'})
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

function ToolCall({ entry, skin }: { entry: ToolEntry; skin: Skin }) {
  const c = SKINS[skin];
  const status = entry.status ?? 'success';
  const dot = status === 'error' ? c.err : status === 'pending' ? c.warn : c.ok;
  const expandable = Boolean(entry.output);

  // <details> keeps the disclosure keyboard-operable and announced. role="button" on the
  // summary is what gets the click PAST the shape's pointer guard — without it tldraw
  // claims the pointerdown and the browser never synthesizes a click on the summary.
  return (
    <details style={{ minWidth: 0 }}>
      <summary
        role="button"
        style={{ listStyle: 'none', cursor: expandable ? 'pointer' : 'default', outline: 'none' }}
      >
        {skin === 'claude' ? (
          <>
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
              <span aria-hidden style={{ color: dot, flexShrink: 0 }}>
                ⏺
              </span>
              <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>
                <span style={{ color: c.fg }}>{entry.tool}</span>
                {entry.arg !== undefined ? (
                  <>
                    <span style={{ color: c.dim }}>(</span>
                    <span style={{ color: c.link }}>{entry.arg}</span>
                    <span style={{ color: c.dim }}>)</span>
                  </>
                ) : null}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', color: c.muted, minWidth: 0 }}>
              <span aria-hidden style={{ visibility: 'hidden', flexShrink: 0 }}>
                ⏺
              </span>
              <span aria-hidden style={{ color: c.dim, flexShrink: 0 }}>
                ⎿
              </span>
              <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>
                {entry.result}
                {expandable ? <span style={{ color: c.dim, marginLeft: 8 }}>(click to expand)</span> : null}
              </span>
            </span>
          </>
        ) : skin === 'codex' ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            <span aria-hidden style={{ color: dot, flexShrink: 0 }}>
              •
            </span>
            <span style={{ color: c.link, minWidth: 0, overflowWrap: 'break-word' }}>
              {entry.tool}
              {entry.arg ? ` ${entry.arg}` : ''}
            </span>
            <span style={{ color: c.dim, flexShrink: 0 }}>{entry.result}</span>
            {expandable ? (
              <span aria-hidden style={{ color: '#565656', flexShrink: 0 }}>
                ▸
              </span>
            ) : null}
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', color: '#8b8b90', minWidth: 0 }}>
            <span aria-hidden style={{ color: dot, flexShrink: 0 }}>
              ◆
            </span>
            <span style={{ flexShrink: 0 }}>{entry.tool.toLowerCase()}</span>
            {entry.arg ? <span style={{ color: c.link, minWidth: 0, overflowWrap: 'anywhere' }}>{entry.arg}</span> : null}
            <span style={{ color: c.dim }}>{entry.result}</span>
          </span>
        )}
      </summary>
      {expandable ? (
        <pre
          style={{
            margin: '4px 0 0',
            paddingLeft: 32,
            whiteSpace: 'pre-wrap',
            color: c.muted,
            font: 'inherit',
            overflowX: 'auto',
          }}
        >
          {entry.output}
        </pre>
      ) : null}
    </details>
  );
}

/** Grok's `┃ ◆ Run … [hooks: n]` card — the gutter form of a tool call. */
function ToolCard({ entry, skin }: { entry: ToolEntry; skin: Skin }) {
  const c = SKINS[skin];
  const heading = [entry.tool, entry.arg].filter(Boolean).join(' ');
  return (
    <div style={{ borderLeft: `2px solid ${c.ok}`, paddingLeft: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span aria-hidden style={{ color: c.ok, flexShrink: 0 }}>
          ◆
        </span>
        <span style={{ fontWeight: 600, color: '#c0c0c0', minWidth: 0, overflowWrap: 'break-word' }}>{heading}</span>
        {entry.hooks != null ? (
          <span style={{ color: c.dim, flexShrink: 0 }}>
            [hooks: <span style={{ color: c.ok }}>{entry.hooks}</span>]
          </span>
        ) : null}
      </div>
      <div style={{ color: '#8b8b90', marginTop: 2, overflowWrap: 'break-word' }}>{entry.result}</div>
    </div>
  );
}

/** Grok's `◆ label [hooks: n/m]` transcript event. */
function EventLine({ entry, skin }: { entry: Extract<Entry, { kind: 'event' }>; skin: Skin }) {
  const c = SKINS[skin];
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span aria-hidden style={{ color: '#c0c0c0', flexShrink: 0 }}>
        ◆
      </span>
      <span style={{ color: c.fg }}>
        {entry.label}
        {entry.elapsed ? <span style={{ color: c.muted }}> {entry.elapsed}</span> : null}
      </span>
      {entry.hooks != null ? (
        <span style={{ color: c.dim }}>
          [hooks: <span style={{ color: c.ok }}>{entry.hooks}</span>
          {entry.hooksOk != null ? `/${entry.hooksOk}` : ''}]
        </span>
      ) : null}
    </div>
  );
}

/** Grok's thought block: the one-liner when empty, the bordered stream when it has a body. */
function Thought({ entry, skin }: { entry: Extract<Entry, { kind: 'thought' }>; skin: Skin }) {
  const c = SKINS[skin];
  const label = `Thought for ${entry.elapsed ?? '0.2s'}`;

  if (!entry.body) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span aria-hidden style={{ color: '#c0c0c0' }}>
          ◆
        </span>
        <span style={{ color: c.muted }}>{label}</span>
      </div>
    );
  }

  return (
    <div style={{ borderLeft: `2px solid ${c.rule}`, paddingLeft: 12, minWidth: 0 }} role="group" aria-label={label}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span aria-hidden style={{ color: c.rule }}>
          ◆
        </span>
        <span style={{ fontWeight: 600, color: '#c0c0c0' }}>{label}</span>
      </div>
      <div style={{ marginTop: 2, whiteSpace: 'pre-wrap', color: c.fg, overflowWrap: 'break-word' }}>{entry.body}</div>
    </div>
  );
}

/** Grok's write preview: line-numbered before/after over a gutter, then hook results. */
function Write({ entry, skin }: { entry: Extract<Entry, { kind: 'write' }>; skin: Skin }) {
  const c = SKINS[skin];
  const row = (l: WriteLine, i: number, which: 'before' | 'after') => (
    <div key={`${which}-${i}`} style={{ display: 'flex', gap: 8, minWidth: 0 }}>
      <span aria-hidden style={{ width: 16, flexShrink: 0, textAlign: 'right', color: c.dim, userSelect: 'none' }}>
        {l.n ?? ''}
      </span>
      <span style={SR_ONLY}>{which}: </span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: which === 'before' ? c.muted : c.fg }}>{l.text}</span>
    </div>
  );

  return (
    <div style={{ borderLeft: `2px solid ${c.rule}`, paddingLeft: 12, minWidth: 0 }} role="region" aria-label="Write preview">
      {entry.before.map((l, i) => row(l, i, 'before'))}
      <div aria-hidden style={{ color: c.rule, margin: '2px 0' }}>
        ───
      </div>
      {entry.after.map((l, i) => row(l, i, 'after'))}
      {entry.hooks?.length ? (
        <div style={{ marginTop: 6 }}>
          {entry.hooks.map((h, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span aria-hidden style={{ color: h.ok ? c.ok : c.err, flexShrink: 0 }}>
                {h.ok ? '✓' : '✗'}
              </span>
              <span style={{ color: c.muted }}>{h.label}</span>
              {h.detail ? <span style={{ color: h.ok ? c.dim : c.err, minWidth: 0 }}>{h.detail}</span> : null}
              {h.ms != null ? <span style={{ color: c.dim }}>{h.ms}ms</span> : null}
              <span style={SR_ONLY}>({h.ok ? 'passed' : 'failed'})</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Diff({ entry, skin }: { entry: Extract<Entry, { kind: 'diff' }>; skin: Skin }) {
  const c = SKINS[skin];
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span aria-hidden style={{ color: c.ok, flexShrink: 0 }}>
          {skin === 'claude' ? '⏺' : skin === 'codex' ? '•' : '◆'}
        </span>
        <span style={{ color: c.fg }}>Update</span>
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <span style={{ color: c.dim }}>(</span>
          <span style={{ color: c.link }}>{entry.file}</span>
          <span style={{ color: c.dim }}>)</span>
        </span>
      </div>
      {entry.summary ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', color: c.muted, minWidth: 0 }}>
          <span aria-hidden style={{ visibility: 'hidden', flexShrink: 0 }}>
            ⏺
          </span>
          <span aria-hidden style={{ color: c.dim, flexShrink: 0 }}>
            ⎿
          </span>
          <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>{entry.summary}</span>
        </div>
      ) : null}
      <pre
        style={{
          margin: '4px 0 0',
          border: '1px solid #202022',
          background: '#101010',
          padding: '6px 12px 6px 8px',
          overflowX: 'auto',
          font: 'inherit',
        }}
      >
        {entry.lines.map((l, i) => {
          const bg =
            l.type === 'add' ? 'rgba(78,169,111,.10)' : l.type === 'del' ? 'rgba(247,118,142,.12)' : 'transparent';
          const mark = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          const markColor = l.type === 'add' ? '#4ea96f' : l.type === 'del' ? '#f7768e' : c.dim;
          return (
            <div key={i} style={{ display: 'flex', minWidth: 0, background: bg }}>
              <span style={{ width: 36, flexShrink: 0, textAlign: 'right', paddingRight: 8, color: '#3b3f52', userSelect: 'none' }}>
                {l.n ?? ''}
              </span>
              <span style={{ width: 12, flexShrink: 0, color: markColor, userSelect: 'none' }}>{mark}</span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: l.type === 'ctx' ? c.muted : c.fg }}>
                {l.type !== 'ctx' ? <span style={SR_ONLY}>{l.type === 'add' ? 'added: ' : 'removed: '}</span> : null}
                {l.text}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

type PermissionEntry = Extract<Entry, { kind: 'permission' }>;
const DEFAULT_OPTIONS = ['Yes', "Yes, and don't ask again this session", 'No, and tell the agent what to do (esc)'];
const GROK_OPTIONS = [
  "Yes, and don't ask again for anything (always-approve mode)",
  'Yes, proceed',
  'No, reject (type to add feedback)',
];

/** Shared by an option row in either permission grammar: arrow keys move, click chooses. */
function useChoice(count: number, initial = 0) {
  const [sel, setSel] = useState(initial);
  const [chosen, setChosen] = useState<number | null>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    setSel((s) => (e.key === 'ArrowDown' ? (s + 1) % count : (s - 1 + count) % count));
  };
  return { sel, chosen, onKeyDown, choose: (i: number) => { setSel(i); setChosen(i); } };
}

function Permission({ entry, skin }: { entry: PermissionEntry; skin: Skin }) {
  const c = SKINS[skin];
  const options = entry.options ?? DEFAULT_OPTIONS;
  const { sel, chosen, onKeyDown, choose } = useChoice(options.length);
  const question = entry.question ?? 'Do you want to proceed?';

  return (
    <fieldset style={{ border: `1px solid ${c.accent}`, padding: '8px 14px 10px', margin: 0, minWidth: 0 }}>
      <legend style={{ color: c.accent, padding: '0 8px' }}>{entry.title ?? 'Bash command'}</legend>
      <div style={{ color: c.fg, overflowWrap: 'anywhere' }}>{entry.command}</div>
      <div style={{ color: c.fg, margin: '8px 0 6px' }}>{question}</div>
      <div role="radiogroup" aria-label={question}>
        {options.map((opt, i) => {
          const active = sel === i;
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(i)}
              onKeyDown={onKeyDown}
              style={{
                display: 'flex',
                width: '100%',
                gap: 8,
                alignItems: 'baseline',
                textAlign: 'left',
                font: 'inherit',
                cursor: 'pointer',
                border: 'none',
                borderRadius: 3,
                padding: '2px 4px',
                background: active ? `${c.accent}1f` : 'transparent',
                color: active ? c.fg : c.muted,
              }}
            >
              <span aria-hidden style={{ color: active ? c.accent : 'transparent', width: '1ch' }}>
                ❯
              </span>
              <span style={{ fontWeight: active ? 600 : 400 }}>
                {i + 1}. {opt}
              </span>
            </button>
          );
        })}
      </div>
      {chosen !== null ? (
        <div role="status" style={{ color: c.ok, marginTop: 6 }}>
          ⏺ {options[chosen]}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Grok's approval card: a `┃` gutter and `(●)` / `(○)` numbered radios, not a fieldset. */
function GrokPermission({ entry, skin }: { entry: PermissionEntry; skin: Skin }) {
  const c = SKINS[skin];
  const options = entry.options ?? GROK_OPTIONS;
  const { sel, chosen, onKeyDown, choose } = useChoice(options.length);
  const title = entry.title ?? 'Write permission probe output file';

  return (
    <div style={{ borderLeft: `2px solid ${c.rule}`, paddingLeft: 12, minWidth: 0 }} role="group" aria-label={title}>
      <div style={{ color: c.fg }}>{title}</div>
      <div style={{ color: '#8b8b90', marginBottom: 6, overflowWrap: 'anywhere' }}>{entry.command}</div>
      <div role="radiogroup" aria-label={title}>
        {options.map((opt, i) => {
          const active = sel === i;
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(i)}
              onKeyDown={onKeyDown}
              style={{
                display: 'flex',
                width: '100%',
                gap: 8,
                alignItems: 'baseline',
                textAlign: 'left',
                font: 'inherit',
                cursor: 'pointer',
                border: 'none',
                background: 'transparent',
                padding: '1px 0',
                color: active ? c.fg : '#8b8b90',
              }}
            >
              <span aria-hidden style={{ flexShrink: 0 }}>
                {i + 1}. {active ? '(●)' : '(○)'}
              </span>
              <span>{opt}</span>
            </button>
          );
        })}
      </div>
      <div style={{ color: c.dim, fontSize: 12, marginTop: 4 }}>
        1/3:select │ Ctrl+o:yolo │ Ctrl+c:cancel
      </div>
      {chosen !== null ? (
        <div role="status" style={{ color: c.ok, marginTop: 4 }}>
          ◆ {options[chosen]}
        </div>
      ) : null}
    </div>
  );
}

function Plan({ entry, skin }: { entry: Extract<Entry, { kind: 'plan' }>; skin: Skin }) {
  const c = SKINS[skin];
  return (
    <div style={{ border: `1px solid ${c.rule}`, borderRadius: 2, minWidth: 0 }} role="region" aria-label={`${entry.file ?? 'plan.md'} plan`}>
      <div style={{ borderBottom: `1px solid ${c.rule}`, padding: '2px 8px', fontSize: 12, color: c.muted }}>
        <span aria-hidden>─ </span>
        {entry.file ?? 'plan.md'}
      </div>
      <div style={{ padding: '4px 8px' }}>
        {entry.lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, minWidth: 0 }}>
            <span aria-hidden style={{ color: '#3b3f52', width: 20, textAlign: 'right', flexShrink: 0, userSelect: 'none' }}>
              {i + 1}
            </span>
            <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>{l}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${c.rule}`, padding: '2px 8px', fontSize: 12, color: c.dim }}>
        <span style={{ color: c.warn }}>◆</span> a approve │ s request changes │ c comment │ q quit plan
      </div>
    </div>
  );
}

const CLAUDE_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const GROK_GLYPHS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const VERBS = ['Thinking', 'Levitating', 'Percolating', 'Noodling', 'Conjuring'];

/**
 * The working line. Two Grok forms, and the split is real: `idle` is the braille spinner
 * with a rotating verb, `working` is the in-turn status with elapsed, tokens and [stop].
 * Claude and Codex have one form each, and both shimmer (see `Shimmer`).
 */
function Thinking({ skin, entry }: { skin: Skin; entry: Extract<Entry, { kind: 'thinking' }> }) {
  const c = SKINS[skin];
  const working = entry.variant === 'working';
  const glyphs = skin === 'grok' ? GROK_GLYPHS : skin === 'codex' ? ['•'] : CLAUDE_GLYPHS;
  const [g, setG] = useState(0);
  const [secs, setSecs] = useState(0);
  const [verb, setVerb] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setG((n) => (n + 1) % glyphs.length), 110);
    return () => clearInterval(id);
  }, [glyphs.length]);
  useEffect(() => {
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setVerb((v) => (v + 1) % VERBS.length), 5200);
    return () => clearInterval(id);
  }, []);

  const shine = skin === 'claude' ? 'ac-shine ac-shine-claude' : skin === 'codex' ? 'ac-shine ac-shine-codex' : undefined;
  const label = entry.label ?? (skin === 'codex' ? 'Working' : `${VERBS[verb]}…`);

  // Grok's in-turn line pins elapsed + tokens + [stop] to the right of the label.
  if (working && skin === 'grok') {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}
      >
        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
          <span aria-hidden style={{ color: '#fff', width: '1ch', display: 'inline-block' }}>
            {glyphs[g % glyphs.length]}
          </span>
          <span style={{ color: '#fff' }}>{label}</span>
          <span style={{ color: '#c0c0c0' }}>{secs}.0s</span>
        </span>
        <span style={{ color: '#c0c0c0', flexShrink: 0 }}>
          ⇣{entry.tokens ?? '16.6k'} <span style={{ color: c.dim }}>[stop]</span>
        </span>
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span aria-hidden style={{ color: c.accent, width: '1ch', display: 'inline-block' }}>
        {glyphs[g % glyphs.length]}
      </span>
      <span className={shine} style={shine ? undefined : { color: '#fff' }}>
        {label}
      </span>
      <span style={{ color: '#7d7d7d' }}>
        ({secs}s{skin === 'claude' ? ` · ↑ ${secs * 137} tokens` : ''} · esc to interrupt)
      </span>
    </div>
  );
}

/* ── composer ───────────────────────────────────────────────────────────── */

const MODES: Record<Skin, { glyph: string; label: string; hint: string; color: (c: (typeof SKINS)[Skin]) => string }> = {
  claude: { glyph: '⏵⏵', label: 'auto mode on', hint: '(shift+tab to cycle) · ← for agents', color: () => '#ffd700' },
  codex: { glyph: '', label: 'gpt-5.6-sol low', hint: '/skills to list available skills', color: (c) => c.dim },
  grok: { glyph: '', label: 'Grok 4.5 (xhigh) · always-approve', hint: '', color: (c) => c.dim },
};

function Composer({
  skin,
  value,
  onChange,
  onSend,
  model,
  cwd,
}: {
  skin: Skin;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  model?: string;
  cwd: string;
}) {
  const c = SKINS[skin];
  const m = MODES[skin];
  const codex = skin === 'codex';
  const grok = skin === 'grok';

  const matches = slashMatches(skin, value);
  const [active, setActive] = useState(0);
  const clamped = matches.length ? Math.min(active, matches.length - 1) : 0;
  const pick = (name: string) => {
    onChange(`${name} `);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Typing inside a shape: stop tldraw's global key handlers from reading these as canvas
    // shortcuts (delete, arrow-nudge, tool switches).
    e.stopPropagation();
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % matches.length : (a - 1 + matches.length) % matches.length));
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Enter completes the highlighted command rather than sending a bare `/mod`.
    const hit = matches[clamped];
    if (hit) pick(hit.name);
    else onSend();
  };

  const menu = matches.length ? (
    <SlashMenu skin={skin} commands={matches} active={clamped} onHover={setActive} onPick={pick} />
  ) : null;

  return (
    <div style={{ flexShrink: 0, padding: '8px 12px 10px', borderTop: `1px solid ${c.dim}44` }}>
      {skin === 'claude' ? (
        <>
          {menu}
          <div style={{ textAlign: 'right', fontSize: 12, color: '#949494', paddingBottom: 2 }}>
            <span aria-hidden>◉</span> xhigh · /effort
          </div>
        </>
      ) : null}
      {grok ? menu : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          padding: codex ? '6px 8px' : '2px 6px',
          background: codex ? '#353535' : grok ? c.bg : 'transparent',
          border: grok ? '1px solid #505058' : 'none',
          borderTop: skin === 'claude' ? '1px solid #808080' : undefined,
          borderBottom: skin === 'claude' ? '1px solid #808080' : undefined,
          borderRadius: grok ? 2 : 0,
        }}
      >
        <span aria-hidden style={{ color: c.caret, flexShrink: 0, fontWeight: codex ? 700 : 400 }}>
          {c.marker}
        </span>
        <input
          type="text"
          aria-label="Prompt"
          placeholder={codex ? 'Use /skills to list available skills' : 'Ask anything, or / for commands…'}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            font: 'inherit',
            color: c.fg,
            caretColor: c.caret,
          }}
        />
        <button
          type="button"
          onClick={onSend}
          style={{
            flexShrink: 0,
            font: 'inherit',
            fontSize: 11,
            padding: '2px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            border: `1px solid ${c.accent}66`,
            background: `${c.accent}1f`,
            color: c.accent,
          }}
        >
          send
        </button>
      </div>

      {codex ? menu : null}

      <div style={{ marginTop: 5, fontSize: 12, minWidth: 0, overflowWrap: 'break-word' }}>
        <span style={{ color: m.color(c) }}>
          {m.glyph ? <span aria-hidden>{m.glyph} </span> : null}
          {skin === 'codex' ? `${model ?? m.label} · ${cwd}` : m.label}
        </span>
        {m.hint ? <span style={{ color: '#949494' }}> {m.hint}</span> : null}
      </div>
    </div>
  );
}

/**
 * The slash-command palette. A listbox of options, but each option is a real <button>:
 * brainless uses `<li onMouseEnter>` + click, and a bare `li` never receives the click
 * inside a component shape (see the pointer-guard note at the top of this file).
 */
function SlashMenu({
  skin,
  commands,
  active,
  onHover,
  onPick,
}: {
  skin: Skin;
  commands: SlashCommand[];
  active: number;
  onHover: (i: number) => void;
  onPick: (name: string) => void;
}) {
  const c = SKINS[skin];
  // Claude pads the name column so the highlight never shifts the description.
  const nameCols = skin === 'claude' ? 20 : 14;
  const on = skin === 'claude' ? '#afd7ff' : c.fg;
  const off = skin === 'claude' ? '#949494' : c.muted;

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      aria-activedescendant={`ac-slash-${active}`}
      style={{
        margin: skin === 'codex' ? '8px 0 0' : '0 0 8px',
        paddingLeft: skin === 'codex' ? '2ch' : 0,
        borderTop: skin === 'grok' ? `1px solid #505058` : undefined,
        borderBottom: skin === 'grok' ? `1px solid #505058` : undefined,
        padding: skin === 'grok' ? '6px 0' : undefined,
        // Six rows is the full default set for every skin — sized so the common case never
        // clips mid-row, and still scrolls for a longer custom set.
        maxHeight: 168,
        overflowY: 'auto',
      }}
    >
      {commands.map((cmd, i) => {
        const isActive = i === active;
        return (
          <button
            key={cmd.name}
            id={`ac-slash-${i}`}
            type="button"
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(cmd.name)}
            style={{
              display: 'flex',
              width: '100%',
              gap: 8,
              textAlign: 'left',
              font: 'inherit',
              cursor: 'pointer',
              border: 'none',
              background: skin === 'claude' && isActive ? 'transparent' : 'transparent',
              padding: '1px 4px',
              color: isActive ? on : off,
            }}
          >
            {skin === 'grok' ? (
              <span aria-hidden style={{ width: '2ch', flexShrink: 0 }}>
                {isActive ? '❯' : ''}
              </span>
            ) : null}
            <span style={{ flexShrink: 0, width: `${nameCols}ch` }}>{cmd.name}</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cmd.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};
