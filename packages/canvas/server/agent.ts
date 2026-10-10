// The agent side: a set of canvas tools exposed to Claude via an in-process MCP
// server, plus runChat() which drives the Claude Agent SDK and streams typed
// events back out to the HTTP layer. The tools mutate the SAME store the browser
// syncs to, so anything the agent draws appears live on the canvas. All tool
// logic lives in src/canvas-ops.ts (pure, tested); these are thin wrappers.

import { type McpHttpServerConfig, type SDKUserMessage, createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { DATA_MAX_BYTES, type ScreenshotTarget } from '../shared/bridge-wire.ts';
import { resolvePageRef } from '../shared/canvas-pages.ts';
import { SHAPE_COLORS } from '../src/shapes.ts';
import type { CanvasStore } from '../src/store.ts';
import {
  type FetchAsset,
  type OpResult,
  alignOp,
  bumpAllComponents,
  clearOp,
  connectedOp,
  createShapesOp,
  readImageOp,
  deleteShapesOp,
  nextComponentRev,
  placeComponentOp,
  readOp,
  setComponentDataOp,
  updateShapesOp,
} from '../src/canvas-ops.ts';
import { componentHistory, componentRecordsFor, editComponent, isShared, listComponents, readComponent, restoreComponent, writeComponent, writeDataFile } from './components.ts';
import { adoptFromShared, promoteToShared } from './component-share-ops.ts';
import { callComponent } from './component-commands.ts';
import { type TurnAccum, classifySdkMessage } from './classify.ts';
import { type McpRegistryEntry, MCP_REGISTRY, resolveMcpEntry } from './mcp-registry.ts';
import type { TurnCanvasStore } from './turn-canvas-store.ts';
import type { ChatEvent } from '../shared/chat-wire.ts';
import type { ComponentVersion } from '../shared/platform-rpc.ts';
import { chatSkillSources, skillRecordsFor, writeSkill } from './skills.ts';
import { SkillName, UploadSkillInput } from '../shared/skills-wire.ts';

const MODEL = process.env.CANVAS_MODEL ?? 'haiku';

// 1M context is selected via the `[1m]` model suffix (the same one the Claude Code CLI
// uses; works on subscription auth — the `betas` option does NOT). BILLING: on
// Max/Team/Enterprise, Opus 1M is INCLUDED FREE but Sonnet 1M costs usage credits; on
// Pro both cost credits. So auto-upgrade OPUS only (free); leave sonnet/haiku standard
// to avoid silently billing 1M-sonnet on the default model. Want sonnet-1M? select
// `sonnet[1m]` explicitly (the suffix passes straight through untouched).
const FREE_1M_MODELS = new Set(['opus', 'claude-opus-4-8', 'claude-opus-5-5']);
const withContext = (m: string): string => (FREE_1M_MODELS.has(m) ? `${m}[1m]` : m);

// The chat sends friendly family aliases (sonnet/opus/haiku). The SDK's bundled aliases still
// resolve to claude-sonnet-4-6 / claude-opus-4-8 / claude-haiku-4-5, so pin them to the explicit
// Sonnet 5 / Opus 5.5 / Haiku 5.5 ids. Any explicit id (or a `[1m]` suffix) isn't in the map and
// passes through untouched.
const ALIAS_TO_ID: Record<string, string> = { sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };
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

/** Capture a PNG of `target` (data URL), or null if no browser answered. */
export type CaptureView = (target?: ScreenshotTarget) => Promise<string | null>;

/** Build the in-process MCP server whose tools mutate `store`. `originChatId` is the
 * chat shape id this turn runs in; shapes the agent creates are tucked beside it and
 * linked back to it with an arrow. */
/** Fan out a shared-library change to every OTHER canvas that placed the module (#55): the
 * bridge injects this (it holds the session registry); it returns how many canvases reloaded.
 * Absent (single-store contexts, tests) ⇒ only the current store is bumped. */
export type BumpShared = (module: string) => number;

/** The `send_message` tool body (bridge binds it — it holds ChatMeta + the turn dispatcher).
 * Posts a message into ANOTHER chat card's thread and kicks its turn, fire-and-forget (the
 * reply streams into that card; the sender polls read_canvas/read_connected). Present ⇒ the
 * agent gets a `send_message` tool; absent (tests, non-bridge contexts) ⇒ omitted. */
export type SendToChat = (targetChatId: string, message: string, canvasId?: string, author?: string | null) => { ok: true } | { ok: false; error: string };

/**
 * The `select_page` tool body (bridge binds it — it holds the canvas's SSE subscribers).
 * Asks the TURN'S INITIATOR's open editors to switch page, and returns how many streams the
 * ask REACHED — delivery, not application (the browser still declines a page it has not
 * synced). 0 is the certain answer: nobody was even asked.
 *
 * The viewer is ALREADY BOUND by the binder, which is the point of the seam's shape: the
 * bridge read the edge-stamped identity and closed over it, so agent.ts and canvas-ops.ts
 * never handle a user id and cannot accidentally treat one as authorization. Absent
 * (tests, any turn with no identifiable initiator) ⇒ the tool is omitted
 * rather than broadcasting to everyone.
 */
export type SelectPage = (pageId: string) => number;

/** The `component_history` tool body, extracted so it unit-tests without the SDK. One line per version — newest first, with WHO and WHEN,
 * which is exactly the question ADR-0022 decision 4 exists to make answerable.
 *
 * An unattributed version renders as `unknown` rather than being hidden or guessed: a write
 * made before attribution existed, or by a process with no user, is still a real event, and
 * quietly attributing it to someone would be worse than admitting the gap. Empty is not an
 * error either — it is the answer for a Component that lives only in the shared or platform
 * tier, whose history is not (yet) a Record. */
export function formatComponentHistory(module: string, versions: ComponentVersion[]): string {
  if (versions.length === 0) return `${module} has no recorded history in this canvas's own library.`;
  const lines = versions.map((v) => `  v${v.version} — ${v.createdAt.toISOString()} by ${v.createdBy ?? 'unknown'}`);
  return `${module} — ${versions.length} version(s), newest first:\n${lines.join('\n')}`;
}

/** What the agent is told after a restore (#362). Two facts, and both are load-bearing: the
 * restore landed as a NEW revision, and the version it replaced is still on the record. An
 * agent that believed recovery was destructive would hesitate to use it — which is how a
 * five-minute fix turns back into an incident. */
export function formatComponentRestore(module: string, version: number, rev: number): string {
  return `Restored ${module} to the source of v${version} — that is now v${rev}. Nothing was erased: v${rev - 1} (what it said before this restore) is still in the history, so this is undoable too.`;
}

/** write_skill: the chat agent authors a workspace skill. Same contract (shared/skills-wire.ts)
 *  and same writer as the MCP upload_skill — Records first, then the rendered files — so the two
 *  doors cannot drift. Discovery is a scan at turn start, so the skill is usable next turn. */
export async function writeSkillOp(
  name: string,
  files: Array<{ path: string; content: string }>,
  write: (skill: string, files: Array<{ path: string; content: string }>) => Promise<void> = writeSkill,
): Promise<{ text: string; isError?: true }> {
  const skill = SkillName.safeParse(name);
  const body = UploadSkillInput.safeParse({ files });
  if (!skill.success || !body.success) {
    return { text: `Error: ${(skill.success ? body.error : skill.error)?.issues[0]?.message ?? 'invalid skill'}`, isError: true };
  }
  try {
    await write(skill.data, body.data.files);
    return { text: `Wrote skill ${skill.data} (${body.data.files.length} file(s)). It is available from the next turn as workspace:${skill.data}.` };
  } catch (e) {
    return { text: `Error: ${(e as Error).message}`, isError: true };
  }
}

/** The `send_message` tool body, extracted so the guard rails unit-test without the SDK:
 * self-sends and unknown targets are refused; a delivered message is attributed to the
 * origin chat card and routed on the SENDER's canvas. */
export function sendMessageOp(
  store: CanvasStore,
  sendToChat: SendToChat,
  input: { chat_id: string; message: string },
  originChatId?: string,
  canvasId?: string,
): string {
  const { chat_id, message } = input;
  if (chat_id === originChatId) return 'That is YOUR OWN chat — send_message targets a different chat card.';
  const target = store.getState().shapes.find((s) => s.type === 'chat' && s.id === chat_id);
  if (!target) return `No chat card with id "${chat_id}" on this canvas. Use read_canvas to list chat shapes.`;
  const sent = sendToChat(chat_id, originChatId ? `[from ${originChatId}] ${message}` : message, canvasId);
  if (!sent.ok) return `Not delivered: ${sent.error}`;
  return `Delivered to ${chat_id}; its turn is running. The reply appears in that chat card — poll read_canvas/read_connected if you need it.`;
}

/** The `select_page` tool body. The refusals are the interesting part: an unresolvable name
 *  and a viewer with no open tab are DIFFERENT failures, and collapsing them would let the
 *  agent report success for either. Neither wording claims the view actually changed —
 *  see {@link SelectPage}: the channel reports delivery, and the browser is still free to
 *  decline a page it has not synced. */
export function selectPageOp(store: CanvasStore, selectPage: SelectPage, page: string): OpResult {
  const pages = store.getState().pages ?? [];
  let pageId: string;
  try {
    pageId = resolvePageRef(pages, page);
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
  const name = pages.find((p) => p.id === pageId)?.name ?? pageId;
  // 0 is not an error — the ask was well-formed, the human just has no tab open here. It IS
  // reported, because "switched you to Roadmap" when nothing moved is the failure that costs
  // the human a confusing minute figuring out why their screen looks the same.
  if (selectPage(pageId) === 0) {
    return { text: `Nothing moved: nobody with an open view of this canvas matched you, so the switch to ${JSON.stringify(name)} was not shown to anyone. Tell the human they can switch to it themselves in the page switcher.` };
  }
  return { text: `Asked your open view(s) to switch to ${JSON.stringify(name)} (${pageId}). The canvas itself is unchanged and nobody else's view moved. Say you have switched them over, not that you have verified it — this is a one-way message to their browser, so if they say they are still on the old page, believe them.` };
}

/** What `view_canvas` asks the browser to render. Named shapes are checked against the
 *  store first: the browser silently skips an id it does not have, so an unchecked typo would
 *  come back as "nothing to show" instead of naming the bad id. */
export function viewTargetOp(store: CanvasStore, page?: string, ids?: string[]): { target: ScreenshotTarget } | OpResult {
  const state = store.getState();
  if (ids?.length) {
    const known = new Set(state.shapes.map((s) => s.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) return { text: `No shape with id ${missing.join(', ')} on this canvas — read_canvas lists the ids.`, isError: true };
    return { target: { ids } };
  }
  if (!page) return { target: {} };
  try {
    return { target: { pageId: resolvePageRef(state.pages ?? [], page) } };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}

/** True for the room-backed store a chat turn runs on (#310); a plain `CanvasStore` (tests,
 *  single-process contexts) has no settle points and the wrapper below is a no-op. */
const isTurnStore = (s: CanvasStore): s is TurnCanvasStore => typeof (s as TurnCanvasStore).commit === 'function';

/**
 * The canvas tools, with each handler settled against the room (#310).
 *
 * THIS is the await point the chat agent was missing. `CanvasStore` is synchronous by design
 * (ADR-0019: it is the seam that keeps `src/canvas-ops.ts` untouched), so there is nowhere
 * INSIDE an op to flush — but the MCP tool handler wrapping the op is already `async`, one
 * level above the seam. Committing here leaves canvas-ops.ts entirely alone and still puts an
 * `await` between every pair of tool calls, so shapes reach the room as the agent draws them.
 *
 * A commit failure becomes the tool's OWN error result: the agent is told, in the room's own
 * words, that what it just drew did not land. It is never swallowed — "I drew it" over an
 * unchanged canvas is the expensive failure mode (`src/remote-store.ts`).
 *
 * A refused op discards instead of committing, mirroring `bridge.ts`'s `inRoom`: nothing a
 * rejected tool queued should reach the room.
 *
 * EVERY tool settles, not only the mutating ones. A settle also reopens the store, so the read
 * tools are what most need it: the next `read_canvas` then answers from a mirror taken after the
 * previous tool call, which is how a human's mid-turn edit becomes visible to the agent.
 */
export function createCanvasTools(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, sendToChat?: SendToChat, fetchAsset?: FetchAsset, selectPage?: SelectPage, author: string | null = null) {
  const settle = <T extends { handler: (args: never, extra: never) => Promise<{ isError?: boolean }> }>(def: T): T => {
    if (!isTurnStore(store)) return def;
    const inner = def.handler;
    return {
      ...def,
      handler: async (args: never, extra: never) => {
        const r = await inner(args, extra);
        if (r.isError) {
          await store.discard();
          return r;
        }
        try {
          await store.commit();
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `Error: the canvas did not accept that — ${(e as Error).message}. Read the canvas before assuming your change is there.` }], isError: true };
        }
        return r;
      },
    };
  };
  return createCanvasToolDefs(store, captureView, originChatId, canvasId, bumpShared, sendToChat, fetchAsset, selectPage, author).map(settle);
}

export function createCanvasMcpServer(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, sendToChat?: SendToChat, fetchAsset?: FetchAsset, selectPage?: SelectPage, author: string | null = null) {
  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    tools: createCanvasTools(store, captureView, originChatId, canvasId, bumpShared, sendToChat, fetchAsset, selectPage, author),
  });
}

// `author`: who started this turn, so every Record its tools land names them (ADR-0022
// decision 4). Null when the turn has no identifiable initiator (a guest send).
function createCanvasToolDefs(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, sendToChat?: SendToChat, fetchAsset?: FetchAsset, selectPage?: SelectPage, author: string | null = null) {
  const records = componentRecordsFor(author);
  const skills = skillRecordsFor(author);
  // A turn this one starts in another chat card is still this author's doing.
  const sendAsAuthor: SendToChat | undefined = sendToChat && ((t, m, c) => sendToChat(t, m, c, author));
  // After authoring a module: reload every placed instance so the open canvas re-imports it.
  // A SHARED module additionally reloads sibling canvases that placed it (workspace-wide
  // propagation); an own module reloads only this canvas (behavior-preserving).
  const reloadAfterAuthor = async (module: string): Promise<number> => {
    if (bumpShared && (await isShared(module, canvasId))) return bumpShared(module);
    return bumpAllComponents(store, nextComponentRev(store));
  };
  return [
      tool(
        'read_canvas',
        'Read the shapes on the canvas, including the ones the human drew. Returns id, type, geometry, text, and color for each. Call this before editing so you know what exists and where the free space is. A canvas can have MORE THAN ONE PAGE: when it does, the answer opens with the list of pages and reads all of them — pass `page` to read just one, which you should do whenever the canvas is large enough that a full read would be unwieldy.',
        { page: z.string().optional().describe('A page id from the `Pages:` line of a previous read. Omit to read every page.') },
        async ({ page }) => result(readOp(store, page)),
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
          const r = await readImageOp(store, id, fetchAsset);
          if (!('image' in r)) return result(r);
          return {
            content: [
              { type: 'image' as const, data: r.image.data, mimeType: r.image.mimeType },
              { type: 'text' as const, text: r.text },
            ],
          };
        },
      ),
      tool(
        'view_canvas',
        'Look at a PNG of the canvas. Good for checking spacing, overlapping labels, and layout of primitive shapes. With no arguments you get the page the human is on; pass `page` for another page, or `ids` to look at just those shapes (a frame brings everything inside it) — use `ids` to read a busy area or a single card, since a whole page is shrunk to fit. CAVEAT: this is a tldraw EXPORT that re-renders shapes cleanly, NOT a capture of the human\'s live screen — a custom render_component (especially Mermaid) can look perfect here while being broken/empty in the human\'s actual view. So do not treat a good view_canvas as proof the human can see a component; if the human says a component looks empty or wrong, believe them over this tool. Pairs well with read_canvas (which gives exact coordinates).',
        {
          page: z.string().min(1).optional().describe("A page name as the human says it, or a page: id from read_canvas's Pages: line."),
          ids: z.array(z.string().min(1)).min(1).optional().describe('Shape ids to render instead of a whole page. Takes precedence over `page`.'),
        },
        async ({ page, ids }) => {
          if (!captureView) return { content: [{ type: 'text' as const, text: 'Visual view is unavailable in this setup.' }] };
          const asked = viewTargetOp(store, page, ids);
          if (!('target' in asked)) return result(asked);
          const url = await captureView(asked.target);
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
        'Create one or more shapes in a single batch. Lay them out with sensible spacing; the visible area is roughly x 0..1000, y 0..700. Returns the id of every shape it created — ids are opaque and unguessable, so KEEP them if you intend to update, delete, align, or point an arrow at these shapes later (otherwise you have to read_canvas again to find them).',
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
        "List the reusable component modules this canvas can place: its own dir, the workspace shared library, and the platform library. These are real React files you can read, edit, compose, and place on the canvas.",
        {},
        async () => {
          const mods = await listComponents(canvasId);
          return result({ text: mods.length ? `Components:\n${mods.join('\n')}` : 'No components yet. write_component to create one.' });
        },
      ),
      tool(
        'read_component',
        'Read a component module\'s source (so you can edit it, or learn the conventions before writing a new one).',
        { module: z.string().describe('Component name, e.g. "MarkdownCard" (no extension).') },
        async ({ module }) => {
          try {
            return result({ text: await readComponent(module, canvasId) });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'component_history',
        "A component module's version history: every stored revision, newest first, with who wrote it and when. Use it to answer \"who changed this and when\" and to find the revision to go back to after a bad edit. Own-library modules only — a shared or platform module has no history here.",
        { module: z.string().describe('Component name, e.g. "MarkdownCard" (no extension).') },
        async ({ module }) => {
          try {
            return result({ text: formatComponentHistory(module, await componentHistory(module, canvasId)) });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'restore_component',
        'Put a component module back the way it was at an earlier version — the fix for a bad edit. Call component_history first to choose the version. This APPENDS a new revision rather than rewinding, so nothing is erased and the restore is itself undoable; it also brings back a module that was deleted. Own-library modules only.',
        {
          module: z.string().describe('Component name, e.g. "MarkdownCard" (no extension).'),
          version: z.number().int().positive().describe('The version to bring back, as component_history numbers them.'),
        },
        async ({ module, version }) => {
          try {
            const rev = await restoreComponent(module, version, canvasId, records);
            reloadAfterAuthor(module);
            return result({ text: formatComponentRestore(module, version, rev) });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'write_component',
        [
          "Create or overwrite a reusable React component file in this canvas's own library (writing a platform/shared module name shadows it for this canvas). vite compiles it; place_component then renders it on the canvas.",
          'Rules: `export default` a React component. It receives the placement `data` as props. You CAN import other modules: react/hooks, other components (`import Foo from "./Foo"`) for composition, "mermaid" for diagrams, "flint-chart/vegalite" + "vega"/"vega-lite" for data charts, "xstate" + "@xstate/react" (useMachine) when a component has real states and transitions rather than a couple of booleans, "zod" for the `args` of a component\'s `commands` export, and data files you write with write_data. For a CHART, place the platform `ChartCard` instead of drawing one — it takes a Flint spec (`{chartType, encodings, semantic_types, values}`) and derives scales, axes, legend and colors itself; only write your own chart component if no Flint chart type fits. Use inline styles + SVG. COLORS: the pad surface is DARK — use the cedar design tokens (var(--text), var(--muted), var(--faint) for type; var(--surface)/var(--raised)/var(--overlay) for fills; var(--line) for borders; var(--accent) for the one live/active accent; var(--success)/var(--danger)/var(--warning) for status) and NEVER hardcode a hex text color, or your component renders near-invisible against the pad. The one exception is a component that paints its OWN full background — then be internally consistent within it. Prefer small composable components — a leaf that takes props, and a container that imports it. Read an existing one first to match conventions: `read_component MarkdownCard` for a plain leaf, `read_component VariantBoard` for composition (it embeds components by NAME through the tier chain rather than importing them, so copy its shape only when the thing to embed is chosen at placement time; a container that knows its parts should just import them).',
        ].join(' '),
        {
          module: z.string().describe('Component name, e.g. "MarkdownCard" (letters/digits/_/-, no extension).'),
          source: z.string().describe('Full .tsx source. Must `export default` a React component.'),
        },
        async ({ module, source }) => {
          try {
            await writeComponent(module, source, canvasId, records);
            const reloaded = await reloadAfterAuthor(module);
            return result({ text: `Wrote ${module}.tsx${reloaded ? ` (reloaded ${reloaded} placed instance(s)/canvas(es))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'edit_component',
        'Make a precise edit to a component file: replace a snippet of its source. Use this to iterate instead of rewriting the whole file. Read the file first and copy the exact text. The snippet must occur exactly once unless you pass replace_all — an ambiguous edit is refused rather than applied to whichever one came first.',
        {
          module: z.string().describe('Component name (no extension).'),
          old_string: z.string().describe('Exact text to replace (must occur exactly once, unless replace_all).'),
          new_string: z.string().describe('Replacement text. Empty deletes the snippet.'),
          replace_all: z.boolean().optional().describe('Replace EVERY occurrence instead of requiring a unique one (renames).'),
        },
        async ({ module, old_string, new_string, replace_all }) => {
          try {
            await editComponent(module, old_string, new_string, canvasId, replace_all, records);
            const reloaded = await reloadAfterAuthor(module);
            return result({ text: `Edited ${module}.tsx${reloaded ? ` (reloaded ${reloaded} placed instance(s)/canvas(es))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'write_data',
        `Create or overwrite a data file NEXT TO the components (same dir), so a component can \`import data from "./sales.json"\`. Extensions: .json/.csv/.txt/.md only (max ${DATA_MAX_BYTES} bytes); code goes through write_component. Overwriting reloads placed instances so importers pick up the new data.`,
        {
          name: z.string().describe('File name with extension, e.g. "sales.json" (letters/digits/_/-, .json/.csv/.txt/.md).'),
          source: z.string().describe('Full file content. For .json it must parse.'),
        },
        async ({ name, source }) => {
          try {
            await writeDataFile(name, source, canvasId, records);
            // Blunt bump (same as write_component): we can't cheaply know which modules
            // import this file, so reload every placed instance on this canvas.
            const reloaded = bumpAllComponents(store, nextComponentRev(store));
            return result({ text: `Wrote ${name}${reloaded ? ` (reloaded ${reloaded} placed instance(s))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'write_skill',
        'Create or overwrite a WORKSPACE skill: a SKILL.md (YAML frontmatter with `name` and a `description` that says when to use it, then the instructions) plus any supporting files. Every chat in this workspace gets it from its next turn, as workspace:<name>. Use it when the human asks you to remember a workflow, checklist or convention as a reusable skill. Overwriting replaces those files.',
        {
          name: z.string().describe('Skill name: a plain directory name, e.g. "weekly-standup".'),
          files: z
            .array(z.object({ path: z.string().describe('Relative path, e.g. "SKILL.md" or "templates/report.md".'), content: z.string() }))
            .describe('The files, including SKILL.md.'),
        },
        async ({ name, files }) => result(await writeSkillOp(name, files, (skill, f) => writeSkill(skill, f, skills))),
      ),
      tool(
        'promote_component',
        'Move a component from THIS canvas into the workspace SHARED library (@shared), making it one live source that any canvas can place. After promoting, editing it hot-reloads every canvas that placed it. Use this when a component is broadly useful, not specific to this canvas.',
        { module: z.string().describe('Component name to promote (no extension).') },
        async ({ module }) => {
          try {
            const canvases = await promoteToShared(canvasId, module, () => (bumpShared ? bumpShared(module) : bumpAllComponents(store, nextComponentRev(store)) && 1), records);
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
            const reloaded = await adoptFromShared(canvasId, module, () => bumpAllComponents(store, nextComponentRev(store)), records);
            return result({ text: `Copied shared ${module}.tsx into this canvas${reloaded ? ` (reloaded ${reloaded} placed instance(s))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'place_component',
        'Put an instance of a component module on the canvas at (x, y), sized w×h, with `data` passed to it as props. YOUR (x, y) IS HONORED (not auto-moved), so when placing several related components lay them out as a deliberate layout near your chat card — e.g. a row at the same y, stepping x by w+20. Place them in/near the visible area (x 0..1000, y 0..700) or, for a chat far from the origin, call read_connected first to get your chat\'s position and lay them out beside it. Each new instance is auto-linked back to your chat with an arrow. Returns the id of the instance it placed — ids are opaque and unguessable, so KEEP it if you intend to move it, re-data it (set_component_data), or delete it later. Pass an existing id to move/retarget/re-data that instance.',
        {
          id: z.string().optional().describe('Existing component shape id to update; omit to create a new instance.'),
          module: z.string().describe('Component name to render, e.g. "MarkdownCard".'),
          x: z.number().describe('Top-left x in page coordinates.'),
          y: z.number().describe('Top-left y in page coordinates.'),
          w: z.number().optional().describe('Box width. Default 360.'),
          h: z.number().optional().describe('Box height. Default 260.'),
          data: z.record(z.unknown()).optional().describe('Static props object passed to the component (the data channel).'),
        },
        async ({ id, module, x, y, w, h, data }) =>
          result(placeComponentOp(store, { id, module, x, y, w, h, data, rev: nextComponentRev(store) }, originChatId)),
      ),
      tool(
        'set_component_data',
        'Update just the props (data) of a placed component instance, without touching its module or box. REPLACES the whole data object, so a concurrent edit by someone else is lost: if the component exports `commands`, use call_component instead.',
        {
          id: z.string().describe('The component shape id.'),
          data: z.record(z.unknown()).describe('New props object for the component.'),
        },
        async ({ id, data }) => result(setComponentDataOp(store, id, data)),
      ),
      tool(
        'call_component',
        "Run one of a placed component's declared COMMANDS — a named, typed edit the component exports as `commands` (read_component shows them and their zod `args`). The command runs against the instance's data as it is NOW, so it never overwrites someone's concurrent edit, and its args are checked. Prefer it over set_component_data whenever the component exports commands.",
        {
          id: z.string().describe('The component shape id.'),
          command: z.string().describe('The command name, a key of the component\'s `commands` export.'),
          args: z.record(z.unknown()).optional().describe('Arguments for the command, checked against its `args` schema.'),
        },
        async ({ id, command, args }) => {
          try {
            return result(await callComponent(store, canvasId, id, command, args ?? {}));
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool('clear_canvas', 'Delete every shape on the canvas. Use sparingly.', {}, async () => result(clearOp(store))),
      tool(
        'align_shapes',
        'Align a set of shapes along an edge or center axis. edge is one of: left, right, top, bottom, center-x, center-y.',
        { ids: z.array(z.string()).min(2), edge: z.enum(['left', 'right', 'top', 'bottom', 'center-x', 'center-y']) },
        async ({ ids, edge }) => result(alignOp(store, ids, edge)),
      ),
      // Cross-chat messaging: present only when the bridge injected the seam (it holds ChatMeta
      // + the turn dispatcher). Mirrors the edge MCP's send_message, scoped to chat cards on
      // THIS canvas. Fire-and-forget; the origin chat is stamped into the delivered message so
      // the receiving thread knows who is speaking.
      ...(sendAsAuthor
        ? [
            tool(
              'send_message',
              "Send a message into ANOTHER chat card's thread on this canvas and trigger it to take a turn. Fire-and-forget: the reply streams into that card, not back to you — poll read_canvas/read_connected to see it. The message is attributed to your chat card in that thread. Do not use this to reply to a message that itself arrived via send_message unless the human asked for an ongoing exchange (avoid agent-to-agent loops).",
              {
                chat_id: z.string().describe("The target chat card's shape id (see read_canvas / read_connected)."),
                message: z.string().min(1).describe('The message to post into that chat.'),
              },
              async ({ chat_id, message }) => result({ text: sendMessageOp(store, sendAsAuthor, { chat_id, message }, originChatId, canvasId) }),
            ),
          ]
        : []),
      // Pages. `read_canvas` already names them (its `Pages:` preamble), so there is no
      // list tool here — only the one thing a read cannot do. `select_page` is seam-gated
      // because moving a screen needs to know WHOSE, and only the bridge knows that.
      ...(selectPage
        ? [
            tool(
              'select_page',
              "Switch the human you are talking to over to another page of this canvas — give the page name as they say it, or a page: id. This moves ONLY their view: it changes nothing on the canvas and moves nobody else looking at it. Note that your own chat card stays where it is, so switching them away from it may take this conversation off their screen — prefer it when they asked to be shown something elsewhere, not as a way to tidy up after yourself. It is a one-way message to their browser, not a confirmed change: if it reports nobody was moved, say so instead of claiming you switched them.",
              { page: z.string().min(1).describe("The page name as the human says it, or a page: id from read_canvas's Pages: line.") },
              async ({ page }) => result(selectPageOp(store, selectPage, page)),
            ),
          ]
        : []),
    ];
}

// The typed chat event stream is owned by the shared wire module (one place the
// producer, the source-of-truth stream, and the consumer/router all import). Re-
// exported here so server modules keep a single import site for the wire types.
export type { ChatEvent } from '../shared/chat-wire.ts';

// SECURITY: the canvas chat is a full Claude Code agent — unsandboxed code execution
// driven by a local web chat box with no auth. Anything that can reach the bridge can
// run commands on this machine, so keep the bridge bound to localhost / a trusted LAN.
// Exported for the prompt test (#357): what the prompt promises the agent must match the
// tools it actually has, so the claim is asserted rather than reviewed by eye.
/** The built-in tools a CHAT turn gets: none that touch the shell or the filesystem. Every
 *  change a chat makes goes through an MCP tool (canvas, or an external server). */
export const CHAT_TOOLS = ['Skill', 'WebSearch', 'WebFetch', 'TodoWrite'] as const;

/** Secrets the bridge holds that the agent's own process never needs. The SDK hands its
 *  subprocess process.env wholesale unless told otherwise. */
const TURN_ENV_DENY = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'BETTER_AUTH_SECRET'];

export function turnEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of TURN_ENV_DENY) delete out[k];
  return out;
}

export const CANVAS_APPEND = `\n\nYou also share a tldraw canvas with the human and have canvas tools (mcp__canvas__*): read_canvas, read_connected (call with no args to get YOUR own connected subgraph — the shapes arrow-linked to your chat card, each with full state — since shapes you create are auto-linked back to you), read_image (see a screenshot/photo the human pasted onto the canvas; read_canvas/read_connected list image shapes but redact the pixels), view_canvas, select_page (when a canvas has several PAGES, read_canvas lists them and this switches the human you are talking to over to one — by the name they use; it moves only their view, never the canvas and never anyone else, and your own chat card does not follow them), create_shapes, update_shapes, delete_shapes, clear_canvas, align_shapes (primitives: rectangle, ellipse, text, note, arrow in colors ${SHAPE_COLORS.join(', ')}; page coordinates, visible area roughly x 0..1000 y 0..700). Plus a reusable COMPONENT library: list_components / read_component / write_component / edit_component author real React files in this canvas's own component dir (with the workspace shared library and the read-only platform library as fallbacks), write_data authors sibling data files (.json/.csv/.txt/.md) a component can import, component_history says who changed a module and when (use it when the human asks what happened to a component, or before overwriting one you did not write) with restore_component putting one back to a version it lists (the fix for a bad edit — it appends a revision rather than rewinding, so it erases nothing and is itself undoable), and place_component / set_component_data render instances on the canvas with a \`data\` props object. When a component exports \`commands\` (named, typed edits — read_component shows them), change its data with call_component rather than set_component_data: a command edits the data as it is now, so it cannot clobber what someone else just changed. These registered tools are the ONLY way to author component and data files — you have no shell and no filesystem tools. Components compose (import each other) and take data — prefer them over hand-placed primitives for charts/tables/cards/dashboards/diagrams. For a CHART, place the platform \`ChartCard\`: its \`data\` is a Flint spec (\`{chartType, encodings, semantic_types, values}\`) and Flint derives scales, axes, legend and colors from it, so you never hand-draw a chart. Read the \`chart-authoring\` skill for the chart types and their channels — a channel a chart type does not declare is SILENTLY DROPPED, so guessing produces a wrong chart rather than an error. Components you author also receive a \`setData(patch)\` prop that persists their own state (merges into the instance data, syncs to everyone, survives reload); use real controls (button/input/select/[role=button]) so clicks reach the component instead of dragging the shape. They also receive \`currentUser\` (\`{id, name?, email?, color, kind: 'user'|'guest'}\`, null-ish until resolved) — the viewer's identity — and \`setDisplayName(name)\` (persists a GUEST's chosen name browser-wide; no-op for logged-in users). For anything attributing actions to a person (comments, votes, Q&A), prefer \`currentUser.name\`/\`currentUser.id\` and only fall back to asking for a name (via setDisplayName) when it is unset — never ask per-component. ALWAYS \`list_components\` FIRST before authoring anything — the library already has many components and creating a duplicate (e.g. a new "Markdown" when "MarkdownCard" exists) is a mistake. If one already fits the request, \`place_component\` it (or \`edit_component\` to extend it); \`read_component\` a close match for its conventions; only \`write_component\` a NEW module when nothing suitable exists. When unsure whether something exists, list and read before writing. Use all of this to visualize, diagram, or build whatever the human asks — e.g. draw an architecture, or build a data-driven dashboard, on the canvas.

BOUNDARY (important): you may author ONLY through the component/data tools (which write per-canvas \`src/canvas-<id>/components/\` dirs and the workspace \`shared/components/\` library — both persist across restarts and hot-reload). There is no backend-handler capability: a component cannot get a server-side route of its own, so do not plan around one. Do NOT modify the CORE: the app shell, \`src/canvas-components/\` (the read-only platform library), anything else in \`src/\`, or anything in \`server/\` (especially \`bridge.ts\`). The core is image-only — edits there will NOT persist and can break the live canvas for everyone.

CROSS-CHAT: if you have a send_message tool, you can post a message into another chat card on this canvas and trigger its agent to take a turn (fire-and-forget — poll read_canvas/read_connected for its reply). Messages you send are attributed to your chat card. Use it when the human asks chats to coordinate; never build unattended agent-to-agent reply loops.`;

/** A pasted screenshot the human attached to their message (base64, no data: prefix). */
export type CanvasImage = { media_type: string; data: string };

/**
 * Parse the `images` field of a chat-turn request body into validated {@link CanvasImage}s,
 * dropping any malformed entry.
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

/** ADR-0013 train 2 (#176): this turn's external MCP servers — one entry per registry server
 * the request actually named a token for (`server/mcp-registry.ts`'s decoded `x-mcp-tokens`
 * header). A registry entry with no token in `tokens` is simply absent — no connection
 * attempt, ever, and an unreachable server just degrades this turn's toolset (the SDK's
 * concern, not ours). No `tokens` at all ⇒ no servers. */
export function buildExternalMcpServers(
  tokens: Record<string, string> | undefined,
  // Default-parameter test seam: production always reads the real registry; tests inject a
  // fake one (MCP_REGISTRY is fixed at module load from process.env, which a test can't retarget).
  registry: Readonly<Record<string, McpRegistryEntry>> = MCP_REGISTRY,
): Record<string, McpHttpServerConfig> {
  if (!tokens) return {};
  return Object.fromEntries(
    Object.entries(tokens).flatMap(([name, token]) => {
      const entry = resolveMcpEntry(name, registry);
      return entry ? [[name, { type: 'http' as const, url: entry.url, headers: { authorization: `Bearer ${token}` } }]] : [];
    }),
  );
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
  // ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens, keyed by registry
  // server name (already decoded from the proxied `x-mcp-tokens` header). Absent/empty ⇒ no
  // external server.
  mcpTokens?: Record<string, string>,
  // Cross-chat messaging seam (bridge-bound: ChatMeta + the turn dispatcher). Present ⇒ the
  // agent gets a `send_message` tool targeting other chat cards on this canvas.
  sendToChat?: SendToChat,
  // Per-chat MCP tool opt-outs (`mcp__<server>__<tool>`, from the chat's ChatMeta selection):
  // appended to disallowedTools so a de-selected tool never reaches the model this turn.
  mcpToolOptOuts?: string[],
  // Asset-fetch seam (bridge-bound: it holds the edge origin + the service secret). Since #290
  // an image shape's pixels live behind the edge's asset route, so WITHOUT this `read_image` can
  // only serve the legacy inline data URLs. Absent (tests) ⇒ exactly that, and it says so.
  fetchAsset?: FetchAsset,
  // Page-navigation seam (bridge-bound: it holds the canvas's SSE subscribers AND has already
  // closed over the turn's initiator). Present ⇒ the agent gets `select_page` and can move the
  // person it is talking to. Absent ⇒ omitted — never a broadcast fallback.
  selectPage?: SelectPage,
  // Who started this turn (the edge-stamped author of the send), for the Records its tools
  // land. Null when unknown — a guest send.
  author: string | null = null,
): AsyncGenerator<ChatEvent> {
  // acc tracks the (possibly newly-assigned) sessionId across the turn.
  let acc: TurnAccum = { sessionId, costUsd: 0 };
  const canvas = createCanvasMcpServer(store, captureView, originChatId, canvasId, bumpShared, sendToChat, fetchAsset, selectPage, author);

  const fullOptions = {
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: CANVAS_APPEND },
    // CHAT_TOOLS only: the canvas MCP tools are a turn's one way to change anything.
    tools: [...CHAT_TOOLS],
    disallowedTools: mcpToolOptOuts ?? [],
    // Skills (ADR-0013). A turn loads no setting source at all — not the process home's
    // ~/.claude, not the repo's developer .claude/skills or CLAUDE.md — only the two plugin
    // areas server/skills.ts names (platform + this workspace's rendered Records; discovery is
    // a filesystem SCAN, so materializeSkills has already run), with an allowlist of exactly
    // those so the SDK's bundled skills stay out too.
    settingSources: [] as Array<'user' | 'project' | 'local'>,
    ...chatSkillSources(),
    cwd: process.env.CANVAS_CWD ?? process.cwd(),
    maxTurns: 50,
  };

  try {
    const q = query({
      prompt: buildPrompt(message, images),
      options: {
        model: resolveModelForSdk(model ?? MODEL),
        ...(effort ? { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}), // guide thinking depth; omitted = adaptive default
        mcpServers: { canvas, ...buildExternalMcpServers(mcpTokens) },
        permissionMode: 'bypassPermissions',
        env: turnEnv(process.env),
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
