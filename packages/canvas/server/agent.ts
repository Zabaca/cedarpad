// The agent side: a set of canvas tools exposed to Claude via an in-process MCP
// server, plus runChat() which drives the Claude Agent SDK and streams typed
// events back out to the HTTP layer. The tools mutate the SAME store the browser
// syncs to, so anything the agent draws appears live on the canvas. All tool
// logic lives in src/canvas-ops.ts (pure, tested); these are thin wrappers.

import { type McpHttpServerConfig, type SDKUserMessage, createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { DATA_MAX_BYTES } from '../shared/bridge-wire.ts';
import { resolvePageRef } from '../shared/canvas-pages.ts';
import { SHAPE_COLORS } from '../src/shapes.ts';
import { DataSourceSchema, type MartSidecar } from '../shared/mart-contract.ts';
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
import { componentHistory, editComponent, isShared, listComponents, readComponent, restoreComponent, writeComponent, writeDataFile } from './components.ts';
import { adoptFromShared, promoteToShared } from './component-share-ops.ts';
import { type EndTurnDeps, type EndTurnInput, endTurn } from './inbox.ts';
import { type TurnAccum, classifySdkMessage } from './classify.ts';
import { type McpRegistryEntry, MCP_REGISTRY } from './mcp-registry.ts';
import { reposPromptAppend } from './repo-checkout.ts';
import type { TurnCanvasStore } from './turn-canvas-store.ts';
import type { ChatEvent } from '../shared/chat-wire.ts';
import type { ComponentVersion } from '../shared/platform-rpc.ts';
import { createNotebookMcpServer } from './notebook-agent-tools.ts';

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

/** The `end_turn` tool body (server/inbox.ts binds db + sessionId + notify). Present ⇒ the agent
 * gets an `end_turn` tool + the Stop-hook gate (ADR-0012); absent (canvas-only contexts, tests)
 * ⇒ both are omitted, unchanged. */
export type EndTurn = (input: EndTurnInput) => Promise<string>;

/** The `open_pr` tool body (bridge binds it on the dev-agent runner to `openDevAgentPr`). Present ⇒
 * the agent gets an `open_pr` tool that commits its worktree + opens a PR; absent (every product
 * chat, tests) ⇒ the tool is omitted, unchanged. ADR-0009 Tier 2 / #126. */
export type OpenPr = (input: { title: string; body: string; commitMessage: string }) => Promise<string>;

/** The `send_message` tool body (bridge binds it — it holds ChatMeta + the turn dispatcher).
 * Posts a message into ANOTHER chat card's thread and kicks its turn, fire-and-forget (the
 * reply streams into that card; the sender polls read_canvas/read_connected). Present ⇒ the
 * agent gets a `send_message` tool; absent (tests, non-bridge contexts) ⇒ omitted. */
export type SendToChat = (targetChatId: string, message: string, canvasId?: string) => { ok: true } | { ok: false; error: string };

/**
 * The `select_page` tool body (bridge binds it — it holds the canvas's SSE subscribers).
 * Asks the TURN'S INITIATOR's open editors to switch page, and returns how many streams the
 * ask REACHED — delivery, not application (the browser still declines a page it has not
 * synced). 0 is the certain answer: nobody was even asked.
 *
 * The viewer is ALREADY BOUND by the binder, which is the point of the seam's shape: the
 * bridge read the edge-stamped identity and closed over it, so agent.ts and canvas-ops.ts
 * never handle a user id and cannot accidentally treat one as authorization. Absent
 * (tests, dev-agent turns, any turn with no identifiable initiator) ⇒ the tool is omitted
 * rather than broadcasting to everyone.
 */
export type SelectPage = (pageId: string) => number;

/** The `list_marts` tool body (bridge binds it — it holds the workspace's BlobStore). Marts
 * live only in R2, never on the container filesystem, so WITHOUT this seam the agent has no
 * way to learn a mart exists or what columns it has: it can only guess a name at
 * `place_component`, and a wrong guess renders an empty component indistinguishable from
 * "no data yet". Present ⇒ the agent gets a `list_marts` tool; absent (tests, non-bridge
 * contexts) ⇒ omitted, and the `data_source` params stay usable for a caller who already
 * knows the name. */
export type ListMarts = () => Promise<MartSidecar[]>;

/** The `list_marts` tool body, extracted so it unit-tests without the SDK. Renders each mart's
 * schema + freshness for the model. The EMPTY case is not an error — it is the answer to "does
 * a mart back this?", and it must steer the agent to static `data` rather than leave it to
 * invent a name (an unknown mart renders an empty component that reads as "no data yet"). */
export function formatMartListing(marts: MartSidecar[]): string {
  if (marts.length === 0) {
    return 'No marts are materialized in this workspace. Use static `data` (or write_data) instead of `data_source`.';
  }
  return marts
    .map((m) => {
      const cols = m.columns.map((c) => `    - ${c.name} (${c.type}) — ${c.description}`).join('\n');
      return `${m.name} — ${m.description}\n  as of ${m.generatedAt} · ${m.rowCount} rows\n  columns:\n${cols}`;
    })
    .join('\n\n');
}

/** The `component_history` tool body, extracted so it unit-tests without the SDK (the
 * `formatMartListing` precedent). One line per version — newest first, with WHO and WHEN,
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

/** The Inbox-list line for an end_turn call: the given summary, else derived from the
 *  question (the Stop-gate-nudged path routinely supplies question-only calls — a required
 *  summary made those fail schema validation and retry, doubling end_turn in the transcript). */
export function endTurnSummaryLine(summary: string | undefined, question: string | undefined): string {
  if (summary) return summary;
  if (question) return question.length > 140 ? `${question.slice(0, 140)}…` : question;
  return 'Turn complete.';
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
export function createCanvasTools(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, endTurn?: EndTurn, openPr?: OpenPr, sendToChat?: SendToChat, listMarts?: ListMarts, fetchAsset?: FetchAsset, selectPage?: SelectPage) {
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
  return createCanvasToolDefs(store, captureView, originChatId, canvasId, bumpShared, endTurn, openPr, sendToChat, listMarts, fetchAsset, selectPage).map(settle);
}

export function createCanvasMcpServer(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, endTurn?: EndTurn, openPr?: OpenPr, sendToChat?: SendToChat, listMarts?: ListMarts, fetchAsset?: FetchAsset, selectPage?: SelectPage) {
  return createSdkMcpServer({
    name: 'canvas',
    version: '0.1.0',
    tools: createCanvasTools(store, captureView, originChatId, canvasId, bumpShared, endTurn, openPr, sendToChat, listMarts, fetchAsset, selectPage),
  });
}

function createCanvasToolDefs(store: CanvasStore, captureView?: CaptureView, originChatId?: string, canvasId: string = 'default', bumpShared?: BumpShared, endTurn?: EndTurn, openPr?: OpenPr, sendToChat?: SendToChat, listMarts?: ListMarts, fetchAsset?: FetchAsset, selectPage?: SelectPage) {
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
        { module: z.string().describe('Component name, e.g. "KpiCard" (no extension).') },
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
        { module: z.string().describe('Component name, e.g. "KpiCard" (no extension).') },
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
          module: z.string().describe('Component name, e.g. "KpiCard" (no extension).'),
          version: z.number().int().positive().describe('The version to bring back, as component_history numbers them.'),
        },
        async ({ module, version }) => {
          try {
            const rev = await restoreComponent(module, version, canvasId);
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
          'Rules: `export default` a React component. It receives the placement `data` as props. You CAN import other modules: react/hooks, other components (`import KpiCard from "./KpiCard"`) for composition, "mermaid" for diagrams, "flint-chart/vegalite" + "vega"/"vega-lite" for data charts, "xstate" + "@xstate/react" (useMachine) when a component has real states and transitions rather than a couple of booleans, and data files you write with write_data. For a CHART, place the platform `ChartCard` instead of drawing one — it takes a Flint spec (`{chartType, encodings, semantic_types, values}`) and derives scales, axes, legend and colors itself; only write your own chart component if no Flint chart type fits. Use inline styles + SVG. COLORS: the pad surface is DARK — use the cedar design tokens (var(--text), var(--muted), var(--faint) for type; var(--surface)/var(--raised)/var(--overlay) for fills; var(--line) for borders; var(--accent) for the one live/active accent; var(--success)/var(--danger)/var(--warning) for status) and NEVER hardcode a hex text color, or your component renders near-invisible against the pad. The one exception is a component that paints its OWN full background — then be internally consistent within it. Prefer small composable components (a leaf like KpiCard, a container like Dashboard that imports it). Read an existing one first (e.g. read_component KpiCard) to match conventions.',
        ].join(' '),
        {
          module: z.string().describe('Component name, e.g. "KpiCard" (letters/digits/_/-, no extension).'),
          source: z.string().describe('Full .tsx source. Must `export default` a React component.'),
        },
        async ({ module, source }) => {
          try {
            await writeComponent(module, source, canvasId);
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
            await editComponent(module, old_string, new_string, canvasId, replace_all);
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
            await writeDataFile(name, source, canvasId);
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
        'promote_component',
        'Move a component from THIS canvas into the workspace SHARED library (@shared), making it one live source that any canvas can place. After promoting, editing it hot-reloads every canvas that placed it. Use this when a component is broadly useful, not specific to this canvas.',
        { module: z.string().describe('Component name to promote (no extension).') },
        async ({ module }) => {
          try {
            const canvases = await promoteToShared(canvasId, module, () => (bumpShared ? bumpShared(module) : bumpAllComponents(store, nextComponentRev(store)) && 1));
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
            const reloaded = await adoptFromShared(canvasId, module, () => bumpAllComponents(store, nextComponentRev(store)));
            return result({ text: `Copied shared ${module}.tsx into this canvas${reloaded ? ` (reloaded ${reloaded} placed instance(s))` : ''}.` });
          } catch (e) {
            return result({ text: `Error: ${(e as Error).message}`, isError: true });
          }
        },
      ),
      tool(
        'place_component',
        'Put an instance of a component module on the canvas at (x, y), sized w×h, with `data` passed to it as props. YOUR (x, y) IS HONORED (not auto-moved), so when placing several related components lay them out as a deliberate layout near your chat card — e.g. a row at the same y, stepping x by w+20. Place them in/near the visible area (x 0..1000, y 0..700) or, for a chat far from the origin, call read_connected first to get your chat\'s position and lay them out beside it. Each new instance is auto-linked back to your chat with an arrow. Returns the id of the instance it placed — ids are opaque and unguessable, so KEEP it if you intend to move it, re-data it (set_component_data), or delete it later. Pass an existing id to move/retarget/re-data that instance. If this canvas\'s workspace has a materialized mart backing what you\'re about to show (an operational number, a KPI, a table of current records), pass `data_source` instead of a static `data` snapshot — the component then renders LIVE mart rows with no further tool calls needed to stay current, and its freshness ("as of") is shown automatically.',
        {
          id: z.string().optional().describe('Existing component shape id to update; omit to create a new instance.'),
          module: z.string().describe('Component name to render, e.g. "Dashboard".'),
          x: z.number().describe('Top-left x in page coordinates.'),
          y: z.number().describe('Top-left y in page coordinates.'),
          w: z.number().optional().describe('Box width. Default 360.'),
          h: z.number().optional().describe('Box height. Default 260.'),
          data: z.record(z.unknown()).optional().describe('Static props object passed to the component (the data channel). Omit when using data_source.'),
          data_source: DataSourceSchema.optional().describe(
            'Names the data this component should render LIVE — never a URL, never SQL. Either `{kind:"mart", name}` (a mart from `list_marts`; never a guess — an unknown mart renders EMPTY) or `{kind:"notebook", query, params}`, where query is one of open_problems / problem_observations (params.problemId) / recent_observations (params.sourceId optional), reading the workspace Notebook as of right now. Rows are resolved at render time in the browser (a mart also shows its "as of"), so the canvas stays current without you re-calling this tool.',
          ),
        },
        async ({ id, module, x, y, w, h, data, data_source }) =>
          result(placeComponentOp(store, { id, module, x, y, w, h, data, dataSource: data_source, rev: nextComponentRev(store) }, originChatId)),
      ),
      tool(
        'set_component_data',
        'Update just the props (data) of a placed component instance, without touching its module or box. Cheap way to feed new data into a component. Pass `data_source` to attach/retarget a live mart instead of (or in addition to) static data; omit it to leave an existing mart reference untouched.',
        {
          id: z.string().describe('The component shape id.'),
          data: z.record(z.unknown()).describe('New props object for the component.'),
          data_source: DataSourceSchema.optional().describe('Names a workspace mart this component should render LIVE — a name from `list_marts`, never a URL and never a guess.'),
        },
        async ({ id, data, data_source }) => result(setComponentDataOp(store, id, data, data_source)),
      ),
      tool('clear_canvas', 'Delete every shape on the canvas. Use sparingly.', {}, async () => result(clearOp(store))),
      tool(
        'align_shapes',
        'Align a set of shapes along an edge or center axis. edge is one of: left, right, top, bottom, center-x, center-y.',
        { ids: z.array(z.string()).min(2), edge: z.enum(['left', 'right', 'top', 'bottom', 'center-x', 'center-y']) },
        async ({ ids, edge }) => result(alignOp(store, ids, edge)),
      ),
      // Mart discovery: present only when the bridge injected the seam (it holds the
      // workspace's BlobStore). This is the ONLY way the agent learns what marts exist and
      // what columns they have — see the ListMarts type.
      ...(listMarts
        ? [
            tool(
              'list_marts',
              'List this workspace\'s materialized warehouse MARTS — each one\'s name, what it covers, its columns (name + type + meaning), and how fresh it is ("as of" + row count). Call this BEFORE placing anything that shows an operational number, a KPI, or a table of current records, the same way you call list_components before authoring: it tells you whether a mart already backs the request, and its column names are what your component must read. Pass a name you saw here as `data_source` on place_component. NEVER guess a mart name — an unknown name renders an EMPTY component that looks like "no data yet". An empty list means this workspace has no marts, so use static `data` instead. Read each mart\'s description before you label a card with it: a mart may cover a narrower slice than its name suggests, and that caveat belongs on the card.',
              {},
              async () => result({ text: formatMartListing(await listMarts()) }),
            ),
          ]
        : []),
      // Cross-chat messaging: present only when the bridge injected the seam (it holds ChatMeta
      // + the turn dispatcher). Mirrors the edge MCP's send_message, scoped to chat cards on
      // THIS canvas. Fire-and-forget; the origin chat is stamped into the delivered message so
      // the receiving thread knows who is speaking.
      ...(sendToChat
        ? [
            tool(
              'send_message',
              "Send a message into ANOTHER chat card's thread on this canvas and trigger it to take a turn. Fire-and-forget: the reply streams into that card, not back to you — poll read_canvas/read_connected to see it. The message is attributed to your chat card in that thread. Do not use this to reply to a message that itself arrived via send_message unless the human asked for an ongoing exchange (avoid agent-to-agent loops).",
              {
                chat_id: z.string().describe("The target chat card's shape id (see read_canvas / read_connected)."),
                message: z.string().min(1).describe('The message to post into that chat.'),
              },
              async ({ chat_id, message }) => result({ text: sendMessageOp(store, sendToChat, { chat_id, message }, originChatId, canvasId) }),
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
      // The turn's mandatory terminal (ADR-0012): present only when the bridge injected the inbox
      // seam. Declares the ending — needs_human promotes to the Inbox + notifies; done records
      // completion. Either way the agent then STOPS — this tool NEVER blocks for a reply.
      ...(endTurn
        ? [
            tool(
              'end_turn',
              'ALWAYS call this exactly once as the LAST tool call of your turn, to declare how the turn ends. outcome "needs_human": you are blocked on the human — a decision, approval, or information only they have; supply `question` (it is posted to their Inbox and they are notified; the tool does NOT wait — after calling it, stop; their reply resumes this session). outcome "done": the work for this turn is complete and nothing is pending on the human; the summary is shown in their Inbox list. Never end a turn with an unanswered question in prose — route it through outcome "needs_human". Say everything important in your message first: `summary` is for the Inbox list, not a substitute for your reply.',
              {
                outcome: z.enum(['needs_human', 'done']).describe('needs_human = blocked on the human (requires `question`); done = work complete, nothing pending.'),
                // Optional with a derived fallback: a REQUIRED summary made the schema reject a
                // question-only needs_human call, forcing a visible retry (a doubled end_turn in
                // the transcript). Missing ⇒ derived from the question / a plain "Turn complete."
                summary: z.string().optional().describe('One-line summary of where the turn ended (shown in the inbox list).'),
                question: z.string().optional().describe('needs_human only: the full question / context for the human.'),
              },
              async ({ outcome, summary, question }) => {
                if (outcome === 'needs_human' && !question) {
                  return result({ text: 'outcome "needs_human" requires a `question` — call end_turn again with the question for the human.' });
                }
                const line = endTurnSummaryLine(summary, question);
                const input: EndTurnInput = outcome === 'done' ? { outcome, summary: line } : { outcome, summary: line, question: question! };
                return result({ text: await endTurn(input) });
              },
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
export const CANVAS_APPEND = `\n\nYou also share a tldraw canvas with the human and have canvas tools (mcp__canvas__*): read_canvas, read_connected (call with no args to get YOUR own connected subgraph — the shapes arrow-linked to your chat card, each with full state — since shapes you create are auto-linked back to you), read_image (see a screenshot/photo the human pasted onto the canvas; read_canvas/read_connected list image shapes but redact the pixels), view_canvas, select_page (when a canvas has several PAGES, read_canvas lists them and this switches the human you are talking to over to one — by the name they use; it moves only their view, never the canvas and never anyone else, and your own chat card does not follow them), create_shapes, update_shapes, delete_shapes, clear_canvas, align_shapes (primitives: rectangle, ellipse, text, note, arrow in colors ${SHAPE_COLORS.join(', ')}; page coordinates, visible area roughly x 0..1000 y 0..700). Plus a reusable COMPONENT library: list_components / read_component / write_component / edit_component author real React files in this canvas's own component dir (with the workspace shared library and the read-only platform library as fallbacks), write_data authors sibling data files (.json/.csv/.txt/.md) a component can import, component_history says who changed a module and when (use it when the human asks what happened to a component, or before overwriting one you did not write) with restore_component putting one back to a version it lists (the fix for a bad edit — it appends a revision rather than rewinding, so it erases nothing and is itself undoable), and place_component / set_component_data render instances on the canvas with a \`data\` props object. \`list_marts\` shows this workspace's materialized warehouse MARTS — their columns, meaning, and freshness. CALL IT FIRST, like list_components, whenever the human asks for an operational KPI, a live table, or anything that should reflect current reality rather than a point-in-time snapshot; then pass \`data_source: {kind:'mart', name:'<a name list_marts returned>'}\` instead of a static \`data\` snapshot — the component then renders the mart's current rows with NO further tool call needed to stay fresh, and the canvas shows the mart's "as of"/row-count itself so nobody mistakes it for live-live. A component names a mart, never a URL or endpoint — there is no fetch/poll capability, so don't reach for one. NEVER invent a mart name: an unknown one renders an EMPTY component that looks like "no data yet", so if list_marts returns nothing (or nothing that fits), use static \`data\` and say so. A mart's description may narrow what it actually covers — read it, and put that caveat on the card's label rather than titling it more broadly than the data supports. Static \`data\` (or write_data files) is still the right choice for anything point-in-time, illustrative, or not backed by a mart. These registered tools are the ONLY way to author component and data files — the generic Write/Edit tools are disabled in chat. Components compose (import each other) and take data — prefer them over hand-placed primitives for charts/tables/cards/dashboards/diagrams. For a CHART, place the platform \`ChartCard\`: its \`data\` is a Flint spec (\`{chartType, encodings, semantic_types, values}\` — or omit \`values\` and pass \`data_source\` for a live mart) and Flint derives scales, axes, legend and colors from it, so you never hand-draw a chart. Read the \`chart-authoring\` skill for the chart types and their channels — a channel a chart type does not declare is SILENTLY DROPPED, so guessing produces a wrong chart rather than an error. Components you author also receive a \`setData(patch)\` prop that persists their own state (merges into the instance data, syncs to everyone, survives reload); use real controls (button/input/select/[role=button]) so clicks reach the component instead of dragging the shape. They also receive \`currentUser\` (\`{id, name?, email?, color, kind: 'user'|'guest'}\`, null-ish until resolved) — the viewer's identity — and \`setDisplayName(name)\` (persists a GUEST's chosen name browser-wide; no-op for logged-in users). For anything attributing actions to a person (comments, votes, Q&A), prefer \`currentUser.name\`/\`currentUser.id\` and only fall back to asking for a name (via setDisplayName) when it is unset — never ask per-component. ALWAYS \`list_components\` FIRST before authoring anything — the library already has many components and creating a duplicate (e.g. a new "Markdown" when "MarkdownCard" exists) is a mistake. If one already fits the request, \`place_component\` it (or \`edit_component\` to extend it); \`read_component\` a close match for its conventions; only \`write_component\` a NEW module when nothing suitable exists. When unsure whether something exists, list and read before writing. Use all of this to visualize, diagram, or build whatever the human asks — e.g. read files and draw the architecture, or build a data-driven dashboard, on the canvas.

BOUNDARY (important): you may author ONLY through the component/data tools (which write per-canvas \`src/canvas-<id>/components/\` dirs and the workspace \`shared/components/\` library — both persist across restarts and hot-reload). There is no backend-handler capability: a component cannot get a server-side route of its own, so do not plan around one. Do NOT modify the CORE: the app shell, \`src/canvas-components/\` (the read-only platform library), anything else in \`src/\`, or anything in \`server/\` (especially \`bridge.ts\`). The core is image-only — edits there will NOT persist and can break the live canvas for everyone.

CROSS-CHAT: if you have a send_message tool, you can post a message into another chat card on this canvas and trigger its agent to take a turn (fire-and-forget — poll read_canvas/read_connected for its reply). Messages you send are attributed to your chat card. Use it when the human asks chats to coordinate; never build unattended agent-to-agent reply loops.

ENDING A TURN: if you have an end_turn tool, ALWAYS finish your turn by calling it exactly once — outcome "needs_human" when you are blocked on the human (include your question; never leave a question only in prose), outcome "done" when the work is complete. Say everything important in your message first; the summary is for the human's Inbox list.`;

/** The Stop-hook gate (ADR-0012): a turn may not end until the agent declared its ending via
 * `end_turn`. Pure factory so the guard unit-tests without the SDK: `ended()` reads the per-turn
 * flag (set by the end_turn handler), `aborted()` exempts user interrupts, and after `maxBlocks`
 * refusals the stop is let through (a guardrail, not a cage — the mechanical settle is the
 * fallback) with a log line so degrading compliance is visible. */
export function makeStopGate(
  ended: () => boolean,
  aborted: () => boolean,
  maxBlocks = 2,
): () => Promise<{ decision?: 'block'; reason?: string }> {
  let blocks = 0;
  return async () => {
    if (ended() || aborted()) return {};
    if (blocks >= maxBlocks) {
      console.error('[inbox] turn ended ungated: end_turn was never called after', blocks, 'blocks');
      return {};
    }
    blocks += 1;
    return {
      decision: 'block',
      reason:
        'You must declare how this turn ends before stopping: call the end_turn tool with outcome "needs_human" (you are blocked on the human — include your question) or outcome "done" (the work is complete). Then stop.',
    };
  };
}

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

/** ADR-0013 train 2 (#176): this turn's external MCP servers — one entry per registry server
 * the request actually named a token for (`server/mcp-registry.ts`'s decoded `x-mcp-tokens`
 * header). A registry entry with no token in `tokens` is simply absent — no connection
 * attempt, ever, and an unreachable server just degrades this turn's toolset (the SDK's
 * concern, not ours). No `tokens` at all (dev-agent turns never pass any) ⇒ no servers. */
export function buildExternalMcpServers(
  tokens: Record<string, string> | undefined,
  // Default-parameter test seam: production always reads the real registry; tests inject a
  // fake one (MCP_REGISTRY is fixed at module load from process.env, which a test can't retarget).
  registry: Readonly<Record<string, McpRegistryEntry>> = MCP_REGISTRY,
): Record<string, McpHttpServerConfig> {
  if (!tokens) return {};
  return Object.fromEntries(
    Object.entries(registry)
      .filter(([name]) => tokens[name])
      .map(([name, entry]) => [
        name,
        { type: 'http' as const, url: entry.url, headers: { authorization: `Bearer ${tokens[name]}` } },
      ]),
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
  inbox?: Omit<EndTurnDeps, 'getSessionId'>,
  openPr?: OpenPr,
  cwd?: string,
  skills?: string[],
  // ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens, keyed by registry
  // server name (already decoded from the proxied `x-mcp-tokens` header). CHAT FLAVOR ONLY —
  // `server/turn.ts` never passes this for a dev-agent turn. Absent/empty ⇒ no external server.
  mcpTokens?: Record<string, string>,
  // The turn flavor (server/turn.ts passes flavor.kind). A CHAT turn drops the generic
  // file-mutation tools so components/data are authored ONLY through the registered canvas
  // tools (write_component/edit_component/write_data) — a plain Write drops an unregistered,
  // unserved, never-hot-reloaded file (the QABoard incident). Dev-agent turns keep the full
  // preset: editing repo files in the prepared worktree is their whole job.
  kind: 'chat' | 'dev-agent' = 'chat',
  // Cross-chat messaging seam (bridge-bound: ChatMeta + the turn dispatcher). Present ⇒ the
  // agent gets a `send_message` tool targeting other chat cards on this canvas.
  sendToChat?: SendToChat,
  // Per-chat MCP tool opt-outs (`mcp__<server>__<tool>`, from the chat's ChatMeta selection):
  // appended to disallowedTools so a de-selected tool never reaches the model this turn.
  mcpToolOptOuts?: string[],
  // Mart discovery seam (bridge-bound: it holds the workspace's BlobStore). Present ⇒ the
  // agent gets `list_marts` and can discover what the warehouse actually holds.
  listMarts?: ListMarts,
  // Asset-fetch seam (bridge-bound: it holds the edge origin + the service secret). Since #290
  // an image shape's pixels live behind the edge's asset route, so WITHOUT this `read_image` can
  // only serve the legacy inline data URLs. Absent (tests) ⇒ exactly that, and it says so.
  fetchAsset?: FetchAsset,
  // Page-navigation seam (bridge-bound: it holds the canvas's SSE subscribers AND has already
  // closed over the turn's initiator). Present ⇒ the agent gets `select_page` and can move the
  // person it is talking to. Absent ⇒ omitted — never a broadcast fallback.
  selectPage?: SelectPage,
): AsyncGenerator<ChatEvent> {
  // acc tracks the (possibly newly-assigned) sessionId across the turn; end_turn reads it lazily
  // so a fresh session — whose id only lands in the SDK init message — still promotes correctly.
  let acc: TurnAccum = { sessionId, costUsd: 0 };
  // ADR-0012: the end_turn handler flips this flag; the Stop-hook gate below refuses to let the
  // turn end while it is unset (with a bounded retry budget + abort exemption).
  let turnEnded = false;
  const endTurnSeam = inbox
    ? async (input: EndTurnInput) => {
        const text = await endTurn({ ...inbox, getSessionId: () => acc.sessionId }, input);
        turnEnded = true;
        return text;
      }
    : undefined;
  const canvas = createCanvasMcpServer(store, captureView, originChatId, canvasId, bumpShared, endTurnSeam, openPr, sendToChat, listMarts, fetchAsset, selectPage);
  // The Notebook (ADR-0024): the store agents write and canvas reads. Null when this process
  // has no edge in front of it (local dev without the Worker, the unit suite) — the turn then
  // simply has no notebook tools, rather than tools that quietly write nowhere.
  const notebook = createNotebookMcpServer();
  const stopGate = endTurnSeam
    ? makeStopGate(
        () => turnEnded,
        () => abortController?.signal.aborted ?? false,
      )
    : undefined;

  // The canvas chat is a full Claude Code agent: all built-in tools (Bash, Read, Write,
  // Edit, Web*, Task, ...) plus the canvas MCP server, auto-approved.
  const fullOptions = {
    // Repo checkouts are advertised per turn from what's on disk (ADR-0016): always the
    // workspace root's .repos/, even when a dev-agent turn runs in its own worktree cwd.
    systemPrompt: {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      append: CANVAS_APPEND + reposPromptAppend(process.env.CANVAS_CWD ?? process.cwd()),
    },
    tools: { type: 'preset' as const, preset: 'claude_code' as const }, // all built-in tools (Bash, Read, Write, Edit, Web*, Task...)
    ...(kind === 'chat' ? { disallowedTools: ['Write', 'Edit', 'NotebookEdit', ...(mcpToolOptOuts ?? [])] } : {}),
    // Load user + project .claude config (ADR-0013): 'user' discovers platform skills (baked
    // at the container's ~/.claude/skills), 'project' discovers workspace skills (the
    // package's .claude/skills, rendered from its Records before the turn starts — ADR-0022 /
    // #361: discovery is a filesystem SCAN, so the tree must already exist by the time this
    // runs). Discovery and enable are two stages:
    // the sources find skills, the `skills` filter picks.
    settingSources: ['user', 'project'] as Array<'user' | 'project' | 'local'>,
    // The skill policy is per-turn (ADR-0013): dev-agent turns pass a pinned list; chat
    // turns pass none, and OMITTING the filter enables every discovered skill.
    ...(skills ? { skills } : {}),
    // A dev-agent turn runs in its prepared worktree (ADR-0010 slice 6) — the caller passes
    // that path so edits + resume both scope to it; every product turn keeps the default.
    cwd: cwd ?? process.env.CANVAS_CWD ?? process.cwd(),
    maxTurns: 50,
  };

  try {
    const q = query({
      prompt: buildPrompt(message, images),
      options: {
        model: resolveModelForSdk(model ?? MODEL),
        ...(effort ? { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}), // guide thinking depth; omitted = adaptive default
        mcpServers: { canvas, ...(notebook ? { notebook } : {}), ...buildExternalMcpServers(mcpTokens) },
        permissionMode: 'bypassPermissions',
        includePartialMessages: true, // stream text deltas + tool starts for live feedback
        forwardSubagentText: true, // stream Task-subagent text/thinking inline (parent_tool_use_id-tagged) so the UI can nest it
        agentProgressSummaries: true, // periodic "Analyzing X" summaries on task_progress
        ...(abortController ? { abortController } : {}), // Esc / Stop -> abort this turn
        // ADR-0012: the Stop-hook gate — a turn may not end without an end_turn declaration.
        ...(stopGate ? { hooks: { Stop: [{ hooks: [stopGate] }] } } : {}),
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
