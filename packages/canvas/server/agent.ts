// The agent side: a set of canvas tools exposed to Claude via an in-process MCP
// server, plus runChat() which drives the Claude Agent SDK and streams typed
// events back out to the HTTP layer. The tools mutate the SAME store the browser
// syncs to, so anything the agent draws appears live on the canvas. All tool
// logic lives in src/canvas-ops.ts (pure, tested); these are thin wrappers.

import { type SDKUserMessage, createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { SHAPE_COLORS } from '../src/shapes.ts';
import type { CanvasStore } from '../src/store.ts';
import {
  type OpResult,
  alignOp,
  bumpAllComponents,
  clearOp,
  connectedOp,
  createShapesOp,
  imageSrcOf,
  deleteShapesOp,
  nextComponentRev,
  placeComponentOp,
  readOp,
  setComponentDataOp,
  updateShapesOp,
} from '../src/canvas-ops.ts';
import { adoptSharedComponent, editComponent, isShared, listComponents, promoteComponent, readComponent, writeComponent } from './components.ts';
import { type AskHumanDeps, askHuman } from './inbox.ts';
import { type TurnAccum, classifySdkMessage } from './classify.ts';
import type { ChatEvent } from '../shared/chat-wire.ts';

const MODEL = process.env.CANVAS_MODEL ?? 'sonnet';

// 1M context is selected via the `[1m]` model suffix (the same one the Claude Code CLI
// uses; works on subscription auth — the `betas` option does NOT). BILLING: on
// Max/Team/Enterprise, Opus 1M is INCLUDED FREE but Sonnet 1M costs usage credits; on
// Pro both cost credits. So auto-upgrade OPUS only (free); leave sonnet/haiku standard
// to avoid silently billing 1M-sonnet on the default model. Want sonnet-1M? select
// `sonnet[1m]` explicitly (the suffix passes straight through untouched).
const FREE_1M_MODELS = new Set(['opus', 'claude-opus-4-8']);
const withContext = (m: string): string => (FREE_1M_MODELS.has(m) ? `${m}[1m]` : m);

// The chat sends friendly family aliases (sonnet/opus/haiku). The SDK's bundled `sonnet` alias
// still resolves to claude-sonnet-4-6, so pin it to the explicit Sonnet 5 id to run the canvas
// agent on Sonnet 5. `opus`/`haiku` aliases already track the latest, and any explicit id (or a
// `[1m]` suffix) isn't in the map and passes through untouched.
const ALIAS_TO_ID: Record<string, string> = { sonnet: 'claude-sonnet-5' };
// The SDK model string for a selected alias: pin the alias to an explicit id, then apply the 1M
// context suffix (opus-only, free). Exported for the model-resolution test.
export const resolveModelForSdk = (m: string): string => withContext(ALIAS_TO_ID[m] ?? m);

// One permissive shape schema; normalizeShape() (inside the ops) enforces
// per-type required fields and throws agent-legible errors so the model can
// self-correct on the next turn.
const shapeInput = z.object({
  id: z.string().optional().describe('Omit to create; pass an existing id to update that shape.'),
  type: z.enum(['rectangle', 'ellipse', 'text', 'note', 'arrow']),
  x: z.number().optional().describe('Top-left x in page coordinates (rectangle/ellipse/text/note).'),
  y: z.number().optional().describe('Top-left y in page coordinates.'),
  w: z.number().optional().describe('Width (rectangle/ellipse). Default 160.'),
  h: z.number().optional().describe('Height (rectangle/ellipse). Default 100.'),
  x1: z.number().optional().describe('Arrow start x (omit if startShapeId is set).'),
  y1: z.number().optional().describe('Arrow start y (omit if startShapeId is set).'),
  x2: z.number().optional().describe('Arrow end x (omit if endShapeId is set).'),
  y2: z.number().optional().describe('Arrow end y (omit if endShapeId is set).'),
  startShapeId: z.string().optional().describe('Bind the arrow START to this shape id. The arrow then snaps to that shape and follows it when it moves. Arrow type only; prefer this over x1/y1 when connecting to a known shape.'),
  endShapeId: z.string().optional().describe('Bind the arrow END to this shape id (follows the shape when it moves). Arrow type only; prefer over x2/y2 when connecting to a known shape.'),
  text: z.string().optional().describe('Label / contents.'),
  color: z.enum(SHAPE_COLORS).optional().describe('Default black.'),
});

const result = (r: OpResult) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) });

/** Capture a PNG of the canvas (data URL), or null if no browser is connected. */
export type CaptureView = () => Promise<string | null>;

/** Build the in-process MCP server whose tools mutate `store`. `originChatId` is the
 * chat shape id this turn runs in; shapes the agent creates are tucked beside it and
 * linked back to it with an arrow. */
/** Fan out a shared-library change to every OTHER canvas that placed the module (#55): the
 * bridge injects this (it holds the session registry); it returns how many canvases reloaded.
 * Absent (single-store contexts, tests) ⇒ only the current store is bumped. */
export type BumpShared = (module: string) => number;

/** The `ask_human` tool body (server/inbox.ts binds db + sessionId + notify). Present ⇒ the agent
 * gets an `ask_human` tool; absent (canvas-only contexts, tests) ⇒ the tool is omitted, unchanged. */
export type AskHuman = (input: { summary: string; question: string }) => Promise<string>;

/** The `open_pr` tool body (bridge binds it on the dev-agent runner to `openDevAgentPr`). Present ⇒
 * the agent gets an `open_pr` tool that commits its worktree + opens a PR; absent (every product
 * chat, tests) ⇒ the tool is omitted, unchanged. ADR-0009 Tier 2 / #126. */
export type OpenPr = (input: { title: string; body: string; commitMessage: string }) => Promise<string>;

export function createCanvasMcpServer(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, askHuman?: AskHuman, openPr?: OpenPr) {
  // After authoring a module: reload every placed instance so the open canvas re-imports it.
  // A SHARED module additionally reloads sibling canvases that placed it (workspace-wide
  // propagation); an own module reloads only this canvas (behavior-preserving).
  const reloadAfterAuthor = (module: string): number => {
    if (bumpShared && isShared(module)) return bumpShared(module);
    return bumpAllComponents(store, nextComponentRev(store));
  };
  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    tools: [
      tool(
        'read_canvas',
        'Read every shape on the canvas, including the ones the human drew. Returns id, type, geometry, text, and color for each. Call this before editing so you know what exists and where the free space is.',
        {},
        async () => result(readOp(store)),
      ),
      tool(
        'read_connected',
        'Read the part of the canvas connected to THIS chat (or another node): the graph of shapes reachable by following arrows, each with its full state (text, component data, geometry, color), plus the edges between them. Defaults to this chat card, so call it with NO arguments to get exactly "my nodes and their state" — everything you are linked to. Prefer this over read_canvas when you only care about your own connected items. Returns { root, nodes, edges }.',
        {
          id: z.string().optional().describe('Node id to start from. Defaults to this chat card.'),
          depth: z.number().int().positive().optional().describe('Max arrow hops to follow. Omit for the whole connected group.'),
          direction: z.enum(['out', 'in', 'both']).optional().describe('Follow arrows outward (this -> others), inward (others -> this), or both (default).'),
        },
        async ({ id, depth, direction }) => {
          const root = id ?? originChatId;
          if (!root) return result({ text: 'Error: no starting node (this chat is not on the canvas). Pass an id.', isError: true });
          return result(connectedOp(store, root, { depth, direction }));
        },
      ),
      tool(
        'read_image',
        'Look at an image shape on the canvas (a screenshot or photo the human pasted/dropped). read_canvas / read_connected list image shapes but redact the pixels; call this with the image shape id to actually SEE its contents at full resolution. Better than view_canvas for reading a specific pasted screenshot, since view_canvas re-renders the whole board small.',
        { id: z.string().describe('The image shape id (from read_canvas / read_connected).') },
        async ({ id }) => {
          const src = imageSrcOf(store, id);
          if (!src) return result({ text: `No image data for "${id}" (not an image shape, not found, or its pixels have not synced yet).`, isError: true });
          const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(src);
          if (!m) return result({ text: `Image "${id}" is not an inline data URL I can read (src starts with "${src.slice(0, 24)}...").`, isError: true });
          return {
            content: [
              { type: 'image' as const, data: m[2] as string, mimeType: m[1] as string },
              { type: 'text' as const, text: `Image shape ${id}.` },
            ],
          };
        },
      ),
      tool(
        'view_canvas',
        'Look at a PNG of the canvas. Good for checking spacing, overlapping labels, and layout of primitive shapes. CAVEAT: this is a tldraw EXPORT that re-renders shapes cleanly, NOT a capture of the human\'s live screen — a custom render_component (especially Mermaid) can look perfect here while being broken/empty in the human\'s actual view. So do not treat a good view_canvas as proof the human can see a component; if the human says a component looks empty or wrong, believe them over this tool. Pairs well with read_canvas (which gives exact coordinates).',
        {},
        async () => {
          if (!captureView) return { content: [{ type: 'text' as const, text: 'Visual view is unavailable in this setup.' }] };
          const url = await captureView();
          if (!url) {
            return { content: [{ type: 'text' as const, text: 'No canvas view is open right now (the browser tab may be closed or empty), so I cannot see it. Use read_canvas for the shape list.' }] };
          }
          const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(url);
          if (!m) return { content: [{ type: 'text' as const, text: 'Screenshot capture failed.' }], isError: true };
          return {
            content: [
              { type: 'image' as const, data: m[2] as string, mimeType: m[1] as string },
              { type: 'text' as const, text: 'Current canvas view.' },
            ],
          };
        },
      ),
      tool(
        'create_shapes',
        'Create one or more shapes in a single batch. Lay them out with sensible spacing; the visible area is roughly x 0..1000, y 0..700.',
        { shapes: z.array(shapeInput).min(1) },
        async ({ shapes }) => result(createShapesOp(store, shapes, originChatId)),
      ),
      tool(
        'update_shapes',
        'Update existing shapes by id (move, resize, recolor, or relabel). Only the fields you pass change; everything else is preserved.',
        { shapes: z.array(shapeInput.extend({ id: z.string() })).min(1) },
        async ({ shapes }) => result(updateShapesOp(store, shapes)),
      ),
      tool(
        'delete_shapes',
        'Delete shapes by id.',
        { ids: z.array(z.string()).min(1) },
        async ({ ids }) => result(deleteShapesOp(store, ids)),
      ),
      tool(
        'list_components',
        'List the reusable component modules in the library (src/canvas-components/). These are real React files you can read, edit, compose, and place on the canvas.',
        {},
        async () => {
          const mods = listComponents(canvasId);
          return result({ text: mods.length ? `Components:\n${mods.join('\n')}` : 'No components yet. write_component to create one.' });
        },
      ),
      tool(
        'read_component',
        'Read a component module\'s source (so you can edit it, or learn the conventions before writing a new one).',
        { module: z.string().describe('Component name, e.g. "KpiCard" (no extension).') },
        async ({ module }) => {
          try {
            return result({ text: readComponent(module, canvasId) });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'write_component',
        [
          'Create or overwrite a reusable React component file at src/canvas-components/<module>.tsx. vite compiles it; place_component then renders it on the canvas.',
          'Rules: `export default` a React component. It receives the placement `data` as props. You CAN import other modules: react/hooks, other components (`import KpiCard from "./KpiCard"`) for composition, "mermaid" for diagrams, and data files you write. Use inline styles + SVG. Prefer small composable components (a leaf like KpiCard, a container like Dashboard that imports it). Read an existing one first (e.g. read_component KpiCard) to match conventions.',
        ].join(' '),
        {
          module: z.string().describe('Component name, e.g. "KpiCard" (letters/digits/_/-, no extension).'),
          source: z.string().describe('Full .tsx source. Must `export default` a React component.'),
        },
        async ({ module, source }) => {
          try {
            writeComponent(module, source, canvasId);
            const reloaded = reloadAfterAuthor(module);
            return result({ text: `Wrote ${module}.tsx${reloaded ? ` (reloaded ${reloaded} placed instance(s)/canvas(es))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'edit_component',
        'Make a precise edit to a component file: replace a unique snippet of its source. Use this to iterate per-line instead of rewriting the whole file. Read the file first and copy the exact text.',
        {
          module: z.string().describe('Component name (no extension).'),
          old_string: z.string().describe('Exact text to replace (must occur exactly once in the file).'),
          new_string: z.string().describe('Replacement text.'),
        },
        async ({ module, old_string, new_string }) => {
          try {
            editComponent(module, old_string, new_string, canvasId);
            const reloaded = reloadAfterAuthor(module);
            return result({ text: `Edited ${module}.tsx${reloaded ? ` (reloaded ${reloaded} placed instance(s)/canvas(es))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'promote_component',
        'Move a component from THIS canvas into the workspace SHARED library (@shared), making it one live source that any canvas can place. After promoting, editing it hot-reloads every canvas that placed it. Use this when a component is broadly useful, not specific to this canvas.',
        { module: z.string().describe('Component name to promote (no extension).') },
        async ({ module }) => {
          try {
            promoteComponent(canvasId, module);
            const canvases = bumpShared ? bumpShared(module) : bumpAllComponents(store, nextComponentRev(store)) && 1;
            return result({ text: `Promoted ${module}.tsx to the shared library${canvases ? ` (reloaded ${canvases} canvas(es) that placed it)` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'adopt_shared_component',
        'Copy a SHARED component back into THIS canvas so you can diverge it: this canvas then owns a local copy that shadows the shared one, and later edits to the shared source no longer affect this canvas.',
        { module: z.string().describe('Shared component name to copy into this canvas (no extension).') },
        async ({ module }) => {
          try {
            adoptSharedComponent(canvasId, module);
            const reloaded = bumpAllComponents(store, nextComponentRev(store));
            return result({ text: `Copied shared ${module}.tsx into this canvas${reloaded ? ` (reloaded ${reloaded} placed instance(s))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'place_component',
        'Put an instance of a component module on the canvas at (x, y), sized w×h, with `data` passed to it as props. YOUR (x, y) IS HONORED (not auto-moved), so when placing several related components lay them out as a deliberate layout near your chat card — e.g. a row at the same y, stepping x by w+20. Place them in/near the visible area (x 0..1000, y 0..700) or, for a chat far from the origin, call read_connected first to get your chat\'s position and lay them out beside it. Each new instance is auto-linked back to your chat with an arrow. Pass an existing id to move/retarget/re-data that instance.',
        {
          id: z.string().optional().describe('Existing component shape id to update; omit to create a new instance.'),
          module: z.string().describe('Component name to render, e.g. "Dashboard".'),
          x: z.number().describe('Top-left x in page coordinates.'),
          y: z.number().describe('Top-left y in page coordinates.'),
          w: z.number().optional().describe('Box width. Default 360.'),
          h: z.number().optional().describe('Box height. Default 260.'),
          data: z.record(z.unknown()).optional().describe('Props object passed to the component (the data channel).'),
        },
        async ({ id, module, x, y, w, h, data }) =>
          result(placeComponentOp(store, { id, module, x, y, w, h, data, rev: nextComponentRev(store) }, originChatId)),
      ),
      tool(
        'set_component_data',
        'Update just the props (data) of a placed component instance, without touching its module or box. Cheap way to feed new data into a component.',
        {
          id: z.string().describe('The component shape id.'),
          data: z.record(z.unknown()).describe('New props object for the component.'),
        },
        async ({ id, data }) => result(setComponentDataOp(store, id, data)),
      ),
      tool('clear_canvas', 'Delete every shape on the canvas. Use sparingly.', {}, async () => result(clearOp(store))),
      tool(
        'align_shapes',
        'Align a set of shapes along an edge or center axis. edge is one of: left, right, top, bottom, center-x, center-y.',
        { ids: z.array(z.string()).min(2), edge: z.enum(['left', 'right', 'top', 'bottom', 'center-x', 'center-y']) },
        async ({ ids, edge }) => result(alignOp(store, ids, edge)),
      ),
      // Human-in-the-loop (#61): present only when the bridge injected the inbox seam. Posts to the
      // Inbox + notifies, then the agent must END its turn — this tool NEVER blocks for a reply.
      ...(askHuman
        ? [
            tool(
              'ask_human',
              'Pause and ask the human when you are BLOCKED and need their decision, approval, or missing information you cannot obtain yourself. This posts your question to their Inbox and notifies them; it does NOT wait for an answer. After calling it you MUST commit any work in progress and END YOUR TURN — do not loop or poll. The human replies later, which resumes this exact session with full context. Use sparingly, only when genuinely stuck on something only the human can resolve.',
              {
                summary: z.string().describe('One-line summary of what you need (shown in the inbox list).'),
                question: z.string().describe('The full question / context for the human.'),
              },
              async ({ summary, question }) => result({ text: await askHuman({ summary, question }) }),
            ),
          ]
        : []),
      // Dev-agent PR (ADR-0009 Tier 2 / #126): present only when the bridge injected the open_pr
      // seam (the dev-agent runner's chat context). The agent makes its edits during the chat,
      // then calls this when aligned with the human — it commits the runner's worktree and opens
      // the PR. Supplies title/body/commit message from the thread it is in; the git auth/branch
      // are the runner's (dark until #96). Every product chat omits this tool, unchanged.
      ...(openPr
        ? [
            tool(
              'open_pr',
              'Open a pull request for the changes you have made in this worktree during this conversation. Call it ONCE you and the human are aligned on the change: it stages + commits your edits and opens the PR. Supply the PR title, body (markdown), and commit message from this thread; branching, push, and auth are handled for you. Returns the PR url (or tells you the tree was clean — make your edits first, then call it).',
              {
                title: z.string().describe('PR title.'),
                body: z.string().describe('PR description (markdown).'),
                commitMessage: z.string().describe('Git commit message for your staged changes.'),
              },
              async ({ title, body, commitMessage }) => result({ text: await openPr({ title, body, commitMessage }) }),
            ),
          ]
        : []),
    ],
  });
}

// The typed chat event stream is owned by the shared wire module (one place the
// producer, the source-of-truth stream, and the consumer/router all import). Re-
// exported here so server modules keep a single import site for the wire types.
export type { ChatEvent } from '../shared/chat-wire.ts';

// SECURITY: the canvas chat is a full Claude Code agent — unsandboxed code execution
// driven by a local web chat box with no auth. Anything that can reach the bridge can
// run commands on this machine, so keep the bridge bound to localhost / a trusted LAN.
const CANVAS_APPEND = `\n\nYou also share a tldraw canvas with the human and have canvas tools (mcp__canvas__*): read_canvas, read_connected (call with no args to get YOUR own connected subgraph — the shapes arrow-linked to your chat card, each with full state — since shapes you create are auto-linked back to you), read_image (see a screenshot/photo the human pasted onto the canvas; read_canvas/read_connected list image shapes but redact the pixels), view_canvas, create_shapes, update_shapes, delete_shapes, clear_canvas, align_shapes (primitives: rectangle, ellipse, text, note, arrow in colors ${SHAPE_COLORS.join(', ')}; page coordinates, visible area roughly x 0..1000 y 0..700). Plus a reusable COMPONENT library: list_components / read_component / write_component / edit_component author real React files under src/canvas-components/, and place_component / set_component_data render instances on the canvas with a \`data\` props object. Components compose (import each other) and take data — prefer them over hand-placed primitives for charts/tables/cards/dashboards/diagrams. Components you author also receive a \`setData(patch)\` prop that persists their own state (merges into the instance data, syncs to everyone, survives reload); use real controls (button/input/select/[role=button]) so clicks reach the component instead of dragging the shape. ALWAYS \`list_components\` FIRST before authoring anything — the library already has many components and creating a duplicate (e.g. a new "Markdown" when "MarkdownCard" exists) is a mistake. If one already fits the request, \`place_component\` it (or \`edit_component\` to extend it); \`read_component\` a close match for its conventions; only \`write_component\` a NEW module when nothing suitable exists. When unsure whether something exists, list and read before writing. Use all of this to visualize, diagram, or build whatever the human asks — e.g. read files and draw the architecture, or build a data-driven dashboard, on the canvas.

BACKEND: when a component needs server-side work (call a third-party API with a secret, hit a database, receive a webhook), author a CUSTOM HANDLER at \`server/custom/<name>.ts\` — \`export default (req: Request) => Response\` (or any JSON-serializable value) — reached at \`/api/custom/<name>\`. It may call outbound (APIs, DBs) and the core canvas via \`\${CANVAS_BRIDGE}/api/canvas\` (CANVAS_BRIDGE is in its env); it runs in an isolated process and so CANNOT touch canvas state directly — go through that HTTP API. Read \`server/custom/hello.ts\` first for the shape. New/edited handlers hot-reload with no restart.

BOUNDARY (important): you may author ONLY under \`src/canvas-components/\` (frontend components) and \`server/custom/\` (backend handlers) — these persist across restarts and hot-reload. Do NOT modify the CORE: the app shell, anything in \`src/\` outside \`canvas-components/\`, or anything in \`server/\` outside \`custom/\` (especially \`bridge.ts\`). The core is image-only — edits there will NOT persist and can break the live canvas for everyone.`;

/** A pasted screenshot the human attached to their message (base64, no data: prefix). */
export type CanvasImage = { media_type: string; data: string };

/**
 * Parse the `images` field of a chat-turn request body into validated {@link CanvasImage}s,
 * dropping any malformed entry. The ONE parse both chat-turn entry points share — a canvas
 * `/send` and an Inbox `/reply` speak the same reply/send contract (ADR-0009 / #123), so
 * neither hand-rolls a second, narrower image schema.
 */
export function parseCanvasImages(body: { images?: unknown }): CanvasImage[] {
  const raw = Array.isArray(body.images) ? body.images : [];
  return raw
    .filter((im): im is CanvasImage => !!im && typeof im.media_type === 'string' && typeof im.data === 'string')
    .map((im) => ({ media_type: im.media_type, data: im.data }));
}

/**
 * Build the agent prompt. A plain string for the text-only case; a one-message
 * streaming input (text + image blocks) when the human pasted screenshots — the
 * SDK accepts `query({ prompt: AsyncIterable<SDKUserMessage> })` for multimodal
 * input, and `resume` still applies via options.
 */
function buildPrompt(message: string, images: CanvasImage[]): string | AsyncIterable<SDKUserMessage> {
  if (images.length === 0) return message;
  const content = [
    ...(message ? [{ type: 'text', text: message }] : []),
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
  ];
  async function* once(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } } as SDKUserMessage;
  }
  return once();
}

/**
 * Drive the agent for one user turn. Yields text + tool events as they stream,
 * then a final `done` carrying the sessionId to resume the next turn.
 */
export async function* runChat(
  store: CanvasStore,
  message: string,
  sessionId: string | null,
  captureView?: CaptureView,
  images: CanvasImage[] = [],
  originChatId?: string,
  model?: string,
  forkSession?: boolean,
  abortController?: AbortController,
  effort?: string,
  canvasId: string = 'default',
  bumpShared?: BumpShared,
  inbox?: Omit<AskHumanDeps, 'getSessionId'>,
  openPr?: OpenPr,
): AsyncGenerator<ChatEvent> {
  // acc tracks the (possibly newly-assigned) sessionId across the turn; ask_human reads it lazily
  // so a fresh session — whose id only lands in the SDK init message — still promotes correctly.
  let acc: TurnAccum = { sessionId, costUsd: 0 };
  const askHumanSeam = inbox
    ? (input: { summary: string; question: string }) => askHuman({ ...inbox, getSessionId: () => acc.sessionId }, input)
    : undefined;
  const canvas = createCanvasMcpServer(store, captureView, originChatId, canvasId, bumpShared, askHumanSeam, openPr);

  // The canvas chat is a full Claude Code agent: all built-in tools (Bash, Read, Write,
  // Edit, Web*, Task, ...) plus the canvas MCP server, auto-approved.
  const fullOptions = {
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: CANVAS_APPEND },
    tools: { type: 'preset' as const, preset: 'claude_code' as const }, // all built-in tools (Bash, Read, Write, Edit, Web*, Task...)
    // Load user + project .claude config: 'project' is required so the repo's skills (e.g.
    // .claude/skills/impeccable) are DISCOVERED. The `skills` filter below then exposes only
    // impeccable to the model — every other discovered skill is hidden from its Skill listing.
    // (Discovery and enable are two separate stages: project source finds them, skills picks.)
    settingSources: ['user', 'project'] as Array<'user' | 'project' | 'local'>,
    skills: ['impeccable'],
    cwd: process.env.CANVAS_CWD ?? process.cwd(),
    maxTurns: 50,
  };

  try {
    const q = query({
      prompt: buildPrompt(message, images),
      options: {
        model: resolveModelForSdk(model ?? MODEL),
        ...(effort ? { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}), // guide thinking depth; omitted = adaptive default
        mcpServers: { canvas },
        permissionMode: 'bypassPermissions',
        includePartialMessages: true, // stream text deltas + tool starts for live feedback
        forwardSubagentText: true, // stream Task-subagent text/thinking inline (parent_tool_use_id-tagged) so the UI can nest it
        agentProgressSummaries: true, // periodic "Analyzing X" summaries on task_progress
        ...(abortController ? { abortController } : {}), // Esc / Stop -> abort this turn
        ...fullOptions,
        ...(sessionId ? { resume: sessionId, ...(forkSession ? { forkSession: true } : {}) } : {}),
      },
    });

    for await (const m of q) {
      const { events, acc: next } = classifySdkMessage(m, acc);
      acc = next;
      for (const e of events) yield e;
    }
  } catch (e) {
    // A user-initiated interrupt (Esc/Stop) is a clean stop, not an error chip;
    // sessionId was already captured from the init message, so resume still works.
    if (!abortController?.signal.aborted) acc.error = (e as Error).message;
  }

  yield { kind: 'done', sessionId: acc.sessionId, costUsd: acc.costUsd, error: acc.error, contextPct: acc.contextPct };
}
