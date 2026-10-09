// The chat sessions, lifted out of any React component so they survive a chat
// card being culled (tldraw unmounts off-screen shapes). Each session owns its
// SSE subscription, transcript, and Claude resume token here, keyed by chatId
// (which is the chat shape's id). Views subscribe via useSyncExternalStore.
//
// SSE lifecycle is tied to the SHAPE, not the view: openStream() is idempotent
// and a culled-then-remounted view re-attaches to the still-open stream;
// closeSession() runs only when the chat shape is actually deleted (App watches
// the editor for removed chat shapes).

import { type ChatEvent, type ChatFrame, type TaskStatus, type TodoStatus, isChatFrame } from './chat-wire.ts';
import { registerStream, setBeatTargets, setBusyCheck } from '../src/idle.ts';
import { withCanvasParam, withPadCanvasHeader } from '../src/active-canvas.ts';
import { CANVAS_ID_HEADER } from './bridge-wire.ts';

// `parentId` (set on subagent items) is the spawning Task chip's tool_use id, so the
// view can indent them under it. Tool items carry their own `toolUseId` so a `task`
// event can find and decorate the Task chip with its subagent type + live status.
export type ChatItem =
  | { id: string; kind: 'msg'; role: 'user' | 'agent'; text: string; images?: string[]; parentId?: string }
  | { id: string; kind: 'tool'; label: string; arg?: string; detail?: string; parentId?: string; toolUseId?: string; subagentType?: string; status?: TaskStatus; summary?: string };

export interface ChatSnapshot {
  items: ChatItem[];
  sdk: string | null; // Claude Agent SDK session id, for resume
  busy: boolean;
  status: string;
  subscribed: boolean; // this chat's SSE stream is open — send is gated on true (client half of the subscribe-before-send contract; the server enforces it with 425)
  queue: Array<{ message: string; images: PendingImage[] }>;
  model: string; // which Claude model this chat sends to (SDK alias: sonnet | opus | haiku)
  effort: string; // reasoning effort for this chat ('default' = omit, let the model decide)
  contextPct: number | null; // % of the model's context window used on the last turn
  forkNext: boolean; // one-shot: when true, the next turn forks the parent's SDK session instead of resuming it
  mcp: McpSelection | null; // per-chat MCP opt-outs (server-owned, like model); null = all connected servers/tools on
  tasks: Record<string, TaskInfo>; // in-flight background jobs (keyed by task_id); ephemeral, not persisted
  todos: Record<string, TodoInfo>; // the agent's TaskCreate/TaskUpdate plan (keyed by todo id); ephemeral
}

/** Per-chat MCP opt-out selection (mirrors server/mcp-registry.ts McpSelection — the
 *  shared shape rides ChatEvent 'config' frames and the /config POST). */
export type McpSelection = { disabledServers: string[]; disabledTools: Record<string, string[]> };

// Models offered in the chat card's selector. Aliases the Claude Agent SDK resolves.
export const MODELS = ['sonnet', 'opus', 'haiku'] as const;
export const DEFAULT_MODEL = 'sonnet';

// Reasoning effort, sent alongside the model. 'default' omits the param (adaptive). Lower
// effort = faster, less time staring at "thinking…"; higher = deeper but slower.
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DEFAULT_EFFORT = 'high';

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'stopped', 'killed']);

/** A background job shown in the chat card's jobs tray (shell | subagent | monitor | workflow). */
export interface TaskInfo {
  id: string;
  status: TaskStatus;
  taskType?: string;
  title?: string;
  detail?: string;
  summary?: string;
}

/** A todo from the agent's TaskCreate/TaskUpdate plan, shown in the plan panel. A
 *  stored todo is never the `deleted` tombstone (the router applies it then drops the row). */
export interface TodoInfo {
  id: string;
  subject: string;
  status: Exclude<TodoStatus, 'deleted'>;
}

export interface PendingImage {
  media_type: string;
  data: string;
  dataUrl: string;
}

const EMPTY: ChatSnapshot = { items: [], sdk: null, busy: false, status: '', subscribed: false, queue: [], model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, contextPct: null, forkNext: false, mcp: null, tasks: {}, todos: {} };

const sessions = new Map<string, ChatSnapshot>();
const listeners = new Map<string, Set<() => void>>();

// Connection target (ADR-0009): a base prefix prepended to every bridge URL for a chat,
// keyed by chatId. `''` (unset) = same-origin, so a canvas chat is byte-for-byte today's
// behavior. A Shell-opened Conversation sets a proxy prefix (e.g. `/inbox/:id/bridge`) so
// its stream/send/interrupt/alive reach the owning runner's bridge through the edge proxy
// instead of same-origin. Per-chatId, never a global — two chats can target two bridges.
const targets = new Map<string, string>();

/** Point a chat at a bridge through `prefix` (a base path prepended to its bridge URLs).
 *  `''` = same-origin. Set before openStream so the chat's stream opens under the prefix. */
export function setConnectionTarget(chatId: string, prefix: string): void {
  targets.set(chatId, prefix);
}

/** The connection-target prefix for a chat (`''` = same-origin, the default). */
export function connectionTarget(chatId: string): string {
  return targets.get(chatId) ?? '';
}

/** Build a bridge URL for a chat: its connection-target prefix + the same-origin path. */
function bridgeUrl(chatId: string, path: string): string {
  return `${connectionTarget(chatId)}${path}`;
}

// Canvas override (docked chat panel): the Shell renders a canvas chat OUTSIDE the pad URL,
// so the location-based stamp (withPadCanvasHeader) can't see which canvas it belongs to.
// An explicit per-chat override keeps the docked chat's calls routed to — and claiming —
// the canvas its panel fronts. Never set for in-pad or Inbox chats (the claim stays explicit).
const canvasOverrides = new Map<string, string>();

/** Stamp `canvasId` on all of a chat's bridge calls (a Shell-docked canvas chat). */
export function setCanvasOverride(chatId: string, canvasId: string): void {
  canvasOverrides.set(chatId, canvasId);
}

// First prompt (#CEDA-189MC6): the canvas chat-starter types a prompt BEFORE the chat
// exists, so the prompt can't be sent inline — `send` no-ops until the session is
// `subscribed`, which only happens once the card mounts and its stream opens. The prompt
// is armed against the shape id here and claimed by the chat's own view when it connects.
const firstPrompts = new Map<string, string>();

/** Arm `text` as the first turn of a chat that hasn't opened its stream yet. */
export function armFirstPrompt(chatId: string, text: string): void {
  if (text) firstPrompts.set(chatId, text);
}

/** Claim a chat's armed first prompt (once — a second call returns ''). */
export function takeFirstPrompt(chatId: string): string {
  const text = firstPrompts.get(chatId) ?? '';
  firstPrompts.delete(chatId);
  return text;
}

/** Per-chat bridge headers: the pad-URL stamp, superseded by an explicit canvas override. */
function chatHeaders(chatId: string, headers?: HeadersInit): Record<string, string> {
  const id = canvasOverrides.get(chatId);
  const base = withPadCanvasHeader(headers);
  return id ? { ...base, [CANVAS_ID_HEADER]: id } : base;
}

/** The distinct set of bridge prefixes the idle beat must reach — one per bridge that
 *  currently holds a live chat session. Same-origin canvas chats collapse to `['']`.
 *  Fed to the idle gate so a Shell-connected chat beats its own bridge, not same-origin. */
export function beatTargets(): string[] {
  const set = new Set<string>();
  for (const id of sessions.keys()) set.add(connectionTarget(id));
  return [...set];
}

// One shared SSE connection for ALL chats (each frame arrives tagged with its
// chatId), so a tab holds a single chat connection regardless of how many chat
// cards are open. One EventSource per chat instead would, with the canvas stream,
// saturate the browser's ~6-connections-per-host cap and leave every POST
// (send / shape upserts) stuck pending. See the bridge's chatStream().
let sharedStream: EventSource | null = null;
let streamReady = false;
// The prefix the shared stream was opened under, so an idle-driven reopen re-targets the
// same bridge. One EventSource serves all chats in a tab; a tab is single-target in practice
// (a canvas tab is same-origin; a Shell tab proxies its Conversation), so this holds.
let sharedStreamTarget = '';
// In-progress agent bubble id, keyed by chat AND parent (subagent text streams in its
// own bubble, never merged into the main agent's). `''` parent = the main agent.
const openBubble = new Map<string, string | null>();
const bubbleKey = (chatId: string, parentId?: string) => `${chatId}::${parentId ?? ''}`;
function clearBubbles(chatId: string): void {
  for (const k of [...openBubble.keys()]) if (k.startsWith(`${chatId}::`)) openBubble.delete(k);
}
let idSeq = 0;
const nextItemId = () => `i${(idSeq += 1)}`;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/**
 * A completed tool call split into the two things it says: WHICH tool, and WHAT it acted on.
 *
 * Kept apart because they carry different weight. The tool name is a category you scan past
 * — a transcript is mostly `Read`, `Bash`, `Edit` — while the argument is the specific thing
 * you are actually looking for. Flattened into one string they render at one emphasis and
 * `combined.json` is as quiet as the `Read` in front of it.
 */
export function toolParts(e: Extract<ChatEvent, { kind: 'tool' }>): { name: string; arg?: string } {
  const i = (e.input ?? {}) as Record<string, unknown>;
  const name = e.name;
  if (name === 'Bash' && typeof i.command === 'string') return { name, arg: truncate(i.command, 44) };
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(name) && typeof i.file_path === 'string')
    return { name, arg: basename(i.file_path) };
  if (typeof i.module === 'string') return { name, arg: i.module };
  const n = Array.isArray(i.shapes) ? i.shapes.length : Array.isArray(i.ids) ? i.ids.length : undefined;
  return n ? { name, arg: `×${n}` } : { name };
}

// A short, legible label for a completed tool call — the flat form, for anywhere that has
// only one string to work with. Derived from `toolParts` so the two can never disagree.
function toolLabel(e: Extract<ChatEvent, { kind: 'tool' }>): string {
  const { name, arg } = toolParts(e);
  if (!arg) return name;
  // `×3` is a count, not a subject: it hangs off the name instead of taking the separator.
  return arg.startsWith('×') ? `${name} ${arg}` : `${name} · ${arg}`;
}

/** The tool-name half of a stored label, for rendering the two halves at different weights.
 *  `label` is built as name + separator + arg, so the arg is always its suffix; anything
 *  else (a subagent chip, an argument-less tool) falls through as the whole label. */
export function toolNameOf(label: string, arg?: string): string {
  return arg && label.endsWith(arg) ? label.slice(0, -arg.length).replace(/[\s·]+$/u, '') : label;
}

/** Longest tool input kept for the expandable body. A Write's `content` or a create_shapes
 *  batch can be tens of KB, and the transcript holds every call for the session — the label
 *  is what you scan, this is what you open, and neither needs the whole payload. */
const DETAIL_MAX = 4000;

/**
 * The full text of a tool call, for the disclosure under its label. Returns undefined when
 * it would only repeat the label — an expander that reveals nothing is worse than none.
 *
 * `toolLabel` is deliberately lossy (Bash truncated at 44 chars, paths reduced to their
 * basename) because it has one line to stay scannable in. That threw the actual command
 * away, so a long `curl` read as `curl -s "https://query1.finance.yahoo…` and you could not
 * tell what ran. This keeps it.
 */
export function toolDetail(e: Extract<ChatEvent, { kind: 'tool' }>): string | undefined {
  const i = e.input;
  if (i === null || i === undefined) return undefined;
  // Bash reads as the shell line it is; anything else is a parameter bag, so show its shape.
  const raw =
    e.name === 'Bash' && typeof (i as Record<string, unknown>).command === 'string'
      ? String((i as Record<string, unknown>).command)
      : typeof i === 'string'
        ? i
        : safeJson(i);
  if (!raw) return undefined;
  const text = raw.length > DETAIL_MAX ? `${raw.slice(0, DETAIL_MAX)}\n… truncated (${raw.length} chars)` : raw;
  // Single-line inputs the label already shows in full carry nothing new.
  return text === toolLabel(e) || `${e.name} · ${text}` === toolLabel(e) ? undefined : text;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return ''; // a cyclic or non-serialisable input is not worth failing a render over
  }
}

function notify(chatId: string) {
  listeners.get(chatId)?.forEach((l) => l());
}

// Replace a session immutably (so useSyncExternalStore sees a new reference) and notify.
// Durable per-chat state now lives server-side in ChatMeta + the SDK session JSONL (ADR
// 0004); there is no browser persistence here.
function update(chatId: string, patch: Partial<ChatSnapshot> | ((s: ChatSnapshot) => ChatSnapshot)) {
  const cur = sessions.get(chatId) ?? EMPTY;
  const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
  sessions.set(chatId, next);
  notify(chatId);
}

/** Register a session in memory (idempotent, sync). The transcript + config are pulled
 *  from the server in rehydrate(), triggered by openStream(); nothing is read here. */
export function ensureSession(chatId: string): void {
  if (!sessions.has(chatId)) sessions.set(chatId, EMPTY);
}

/** Pull the server-authoritative transcript + config for a chat and replace local state.
 *  The transcript is derived from the SDK session JSONL (ADR 0004), so it is identical on
 *  any tab/device and survives a recycle. Best-effort: a failed fetch leaves state as-is. */
async function rehydrate(chatId: string): Promise<void> {
  try {
    const res = await fetch(bridgeUrl(chatId, `/api/chat/${chatId}/transcript`), { headers: chatHeaders(chatId) });
    if (!res.ok) return;
    const { config, events, busy } = (await res.json()) as { config?: { model?: string; effort?: string; forkNext?: boolean; mcp?: McpSelection }; events?: ChatEvent[]; busy?: boolean };
    clearBubbles(chatId);
    update(chatId, (s) => ({
      ...s,
      items: [],
      ...(config?.model ? { model: config.model } : {}),
      ...(config?.effort ? { effort: config.effort } : {}),
      ...(typeof config?.forkNext === 'boolean' ? { forkNext: config.forkNext } : {}),
      ...(config?.mcp ? { mcp: config.mcp } : {}),
      // A turn is in flight server-side (ADR-0011): a mid-run opener missed the init frame,
      // so this is how it learns to queue sends. Only ever raises busy — a rehydrate racing
      // a just-settled turn must not clear a busy this tab's own dispatch set.
      ...(busy ? { busy: true, status: s.status || 'working' } : {}),
    }));
    for (const ev of events ?? []) applyEvent(chatId, ev);
  } catch {
    /* offline / bridge not ready — leave state as-is */
  }
}

/** Ensure the single shared chat SSE stream is open; route tagged frames per chat.
 *  Opens under `target` (the connecting chat's prefix; `''` = same-origin). */
function ensureSharedStream(target = ''): void {
  if (sharedStream) return;
  sharedStreamTarget = target;
  const es = new EventSource(withCanvasParam(`${target}/api/chat/stream`));
  let opened = false;
  es.onopen = () => {
    streamReady = true;
    // Unblock send() on every known session (send is gated on `subscribed`).
    for (const id of sessions.keys()) update(id, { subscribed: true });
    // A RE-open (auto-reconnect after a drop) missed live frames — recover them from the
    // server transcript, same as the idle-gate reopen path.
    if (opened) for (const id of sessions.keys()) void rehydrate(id);
    opened = true;
  };
  es.onerror = () => {
    // Drop the gate until EventSource auto-reconnects (onopen re-arms it).
    streamReady = false;
    for (const id of sessions.keys()) update(id, { subscribed: false });
    // A CLOSED stream never auto-reconnects (the server answered with a non-stream response,
    // e.g. mid-deploy). Recreate it after a short backoff — otherwise every chat is stuck on
    // "connecting…" until a manual refresh.
    if (es.readyState === EventSource.CLOSED && sharedStream === es) {
      sharedStream = null;
      setTimeout(() => {
        if (!sharedStream) reopenSharedStream();
      }, 2000);
    }
  };
  es.onmessage = (e) => routeChatFrame(e.data as string);
  sharedStream = es;
}

// Idle gate (src/idle.ts): when the tab is hidden the shared stream is deliberately
// closed so the CF container can sleep; a plain .close() does not auto-reconnect. On
// reopen, every known session rehydrates from the server (live frames missed while
// closed are recovered from the JSONL-derived transcript, ADR 0004).
// Exported for tests, and only for tests — the idle gate below drives it in
// production through `registerStream`. The store's SSE stream is module state,
// so a test file that opens it leaves it open for every file that runs after in
// the same bun process: `ensureSharedStream` short-circuits on `if (sharedStream)
// return`, the next test's fake EventSource is never constructed, and an
// assertion about opening a stream fails somewhere it was never written. That is
// a test-isolation defect, not a product one — the tests pass alone and fail
// together — and this is the smallest honest fix, because the reset it needs is
// a lifecycle transition the module already has rather than a new one invented
// for the test.
export function __closeSharedStreamForTests(): void {
  closeSharedStream();
}

function closeSharedStream(): void {
  if (!sharedStream) return;
  sharedStream.close();
  sharedStream = null;
  streamReady = false;
  for (const id of sessions.keys()) update(id, { subscribed: false });
}
function reopenSharedStream(): void {
  ensureSharedStream(sharedStreamTarget);
  for (const id of sessions.keys()) void rehydrate(id);
}
registerStream({ open: reopenSharedStream, close: closeSharedStream });
setBusyCheck(() => {
  for (const s of sessions.values()) if (s.busy) return true;
  return false;
});
// Beat the bridge(s) behind our live sessions — same-origin for the canvas, or a Shell
// chat's proxy prefix. No sessions ⇒ `[]`; idle then falls back to same-origin (unchanged).
setBeatTargets(beatTargets);

/** Attach a chat to the shared stream (idempotent). Never closed on view unmount.
 *  Pulls the server transcript on attach so a reload / fresh device rehydrates. */
export function openStream(chatId: string): void {
  ensureSession(chatId);
  ensureSharedStream(connectionTarget(chatId));
  void rehydrate(chatId);
  // If the stream is already live, this freshly-attached session can send right away.
  if (streamReady) update(chatId, { subscribed: true });
}

/** Tear a session down for good (the chat shape was deleted). The shared stream
 *  stays open for the remaining chats (one connection, app-lifetime). The durable
 *  ChatMeta + JSONL stay server-side; deleting the card just drops the local view. */
export function closeSession(chatId: string): void {
  sessions.delete(chatId);
  listeners.delete(chatId);
  canvasOverrides.delete(chatId);
  clearBubbles(chatId);
}

export function subscribe(chatId: string, cb: () => void): () => void {
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(cb);
  return () => {
    listeners.get(chatId)?.delete(cb);
  };
}

export function getSnapshot(chatId: string): ChatSnapshot {
  return sessions.get(chatId) ?? EMPTY;
}

/** The client half of the subscribe-before-send contract: is this chat's SSE stream
 *  open? `send()` is gated on this; the server independently rejects an unsubscribed
 *  send with 425 Too Early, so the two ends agree on the same precondition. */
export function isSubscribed(chatId: string): boolean {
  return getSnapshot(chatId).subscribed;
}

/** Set which model this chat sends to. Optimistic locally, authoritative server-side: the
 *  POST updates ChatMeta and broadcasts a `config` frame so other tabs converge (ADR 0004). */
export function setModel(chatId: string, model: string): void {
  ensureSession(chatId);
  update(chatId, { model });
  void postConfig(chatId, { model });
}

/** Set reasoning effort for this chat (server-owned, same as setModel). */
export function setEffort(chatId: string, effort: string): void {
  ensureSession(chatId);
  update(chatId, { effort });
  void postConfig(chatId, { effort });
}

/** Set this chat's MCP opt-out selection (server-owned, same as setModel — anyone on the
 *  chat may change it; tabs converge via the `config` frame). */
export function setMcpSelection(chatId: string, mcp: McpSelection): void {
  ensureSession(chatId);
  update(chatId, { mcp });
  void postConfig(chatId, { mcp });
}

function postConfig(chatId: string, patch: { model?: string; effort?: string; forkNext?: boolean; mcp?: McpSelection }): Promise<unknown> {
  return fetch(bridgeUrl(chatId, `/api/chat/${chatId}/config`), { method: 'POST', headers: chatHeaders(chatId, { 'content-type': 'application/json' }), body: JSON.stringify(patch) }).catch(() => {});
}

/** Seed `newId` as a fork of `parentId` on the SERVER (its ChatMeta resumes the parent's
 *  session with a one-shot fork armed), then rehydrate the child — which pulls the parent's
 *  JSONL transcript until the fork diverges. The parent session is untouched (ADR 0004). */
export function forkSession(parentId: string, newId: string): void {
  ensureSession(newId);
  void fetch(bridgeUrl(newId, `/api/chat/${newId}/fork`), { method: 'POST', headers: chatHeaders(newId, { 'content-type': 'application/json' }), body: JSON.stringify({ from: parentId }) })
    .then(() => rehydrate(newId))
    .catch(() => {});
}

/**
 * Route one raw SSE message to its session: parse JSON, validate it is a
 * {@link ChatFrame}, drop it when its `chatId` is not a live session this client
 * holds, then apply the narrowed event. Malformed JSON and non-frame messages are
 * silently ignored (the shared stream carries comment/ping frames and could carry
 * foreign noise). Exported so the routing seam is unit-tested without an EventSource.
 */
export function routeChatFrame(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // malformed JSON, ignore
  }
  if (!isChatFrame(parsed)) return; // parsed is now narrowed to ChatFrame
  const { chatId, ...ev } = parsed;
  // List-signal listeners (the Inbox doorbell) see EVERY frame — including chats this
  // client doesn't hold a session for (a headless send, another tab's chat).
  for (const l of frameListeners) l(chatId, ev);
  if (!sessions.has(chatId)) return; // a frame for a chat this client doesn't hold
  applyEvent(chatId, ev);
}

// The Inbox "list changed" doorbell (grill 2026-07-10): the container's chat stream is the
// only live channel that observes turn starts/settles, so list consumers subscribe here and
// refetch the authoritative D1 list when a frame implies a row changed. No list data
// rides the stream — it is purely a signal.
const frameListeners = new Set<(chatId: string, ev: ChatEvent) => void>();
export function onChatFrame(cb: (chatId: string, ev: ChatEvent) => void): () => void {
  frameListeners.add(cb);
  return () => void frameListeners.delete(cb);
}
/** Open the shared stream WITHOUT attaching a chat — for signal-only consumers (the Inbox
 * list). Idempotent; the idle gate still closes/reopens it with tab visibility. */
export function openFrameSignal(target = ''): void {
  ensureSharedStream(target);
}

function applyEvent(chatId: string, ev: ChatEvent) {
  if (ev.kind === 'init') {
    // A turn started (ADR-0011). Capture the session id early, and — if this tab didn't
    // start the turn (busy would already be true from its own dispatchSend) — mark busy so
    // send() queues instead of firing into the in-flight turn (a headless send, or another
    // tab's send). The wire's 409 turn_in_flight remains the race backstop.
    update(chatId, (s) => ({ ...s, sdk: ev.sessionId, busy: true, status: s.busy ? s.status : 'working' }));
    return;
  }
  if (ev.kind === 'delta' && ev.text) {
    const key = bubbleKey(chatId, ev.parentId);
    if (ev.role === 'user') {
      // Replay-only: the human's own message (live path adds these locally). A standalone
      // bubble — reset the open bubble so a following agent delta starts a fresh one.
      const id = nextItemId();
      openBubble.set(key, null);
      update(chatId, (s) => ({ ...s, items: [...s.items, { id, kind: 'msg', role: 'user', text: ev.text }] }));
      return;
    }
    const open = openBubble.get(key) ?? null;
    if (open) {
      update(chatId, (s) => ({
        ...s,
        status: '',
        items: s.items.map((it) => (it.id === open && it.kind === 'msg' ? { ...it, text: it.text + ev.text } : it)),
      }));
    } else {
      const id = nextItemId();
      openBubble.set(key, id);
      update(chatId, (s) => ({ ...s, status: '', items: [...s.items, { id, kind: 'msg', role: 'agent', text: ev.text, ...(ev.parentId ? { parentId: ev.parentId } : {}) }] }));
    }
  } else if (ev.kind === 'config') {
    // Server-owned config converged across tabs (ADR 0004): a sibling tab changed model/effort/fork.
    update(chatId, (s) => ({
      ...s,
      ...(ev.model ? { model: ev.model } : {}),
      ...(ev.effort ? { effort: ev.effort } : {}),
      ...(typeof ev.forkNext === 'boolean' ? { forkNext: ev.forkNext } : {}),
      ...(ev.mcp ? { mcp: ev.mcp } : {}),
    }));
  } else if (ev.kind === 'tool_start') {
    if (!ev.parentId) update(chatId, { status: `running ${ev.name}` }); // a subagent's tool_start must not hijack the main status line
  } else if (ev.kind === 'thinking') {
    // Live proof-of-life while the model reasons silently (main agent only).
    if (!ev.parentId && ev.thinkingTokens) update(chatId, { status: `thinking · ~${ev.thinkingTokens.toLocaleString()} tokens` });
  } else if (ev.kind === 'tool_progress') {
    if (!ev.parentId && ev.name) update(chatId, { status: `running ${ev.name} · ${ev.elapsed}s` });
  } else if (ev.kind === 'tool') {
    openBubble.set(bubbleKey(chatId, ev.parentId), null); // next text starts a fresh bubble after the chip
    const id = nextItemId();
    const detail = toolDetail(ev);
    const { arg } = toolParts(ev);
    update(chatId, (s) => ({ ...s, status: 'working', items: [...s.items, { id, kind: 'tool', label: toolLabel(ev), ...(arg ? { arg } : {}), ...(detail ? { detail } : {}), ...(ev.parentId ? { parentId: ev.parentId } : {}), ...(ev.id ? { toolUseId: ev.id } : {}) }] }));
    // end_turn (and its ask_human predecessor in old transcripts) is the one tool whose INPUT
    // is human-facing — the question/summary it posts to the Inbox. Render it as a readable
    // agent bubble after the chip (live AND replay emit the same tool event): a question the
    // human can't read isn't a question.
    const input = ev.name === 'end_turn' || ev.name === 'ask_human' ? (ev.input as { question?: unknown; summary?: unknown } | null) : null;
    const q = typeof input?.question === 'string' && input.question ? input.question : input?.summary;
    if (typeof q === 'string' && q) {
      update(chatId, (s) => ({ ...s, items: [...s.items, { id: nextItemId(), kind: 'msg', role: 'agent', text: q }] }));
    }
  } else if (ev.kind === 'task' && ev.taskId) {
    const taskId = ev.taskId;
    const terminal = !!ev.status && TERMINAL.has(ev.status);
    update(chatId, (s) => {
      // Jobs tray (keyed by task_id): upsert running jobs, drop once terminal.
      const tasks = { ...s.tasks };
      if (terminal) {
        delete tasks[taskId];
      } else {
        const prev: TaskInfo = tasks[taskId] ?? { id: taskId, status: 'running' };
        tasks[taskId] = {
          ...prev,
          ...(ev.status ? { status: ev.status } : {}),
          ...(ev.taskType ? { taskType: ev.taskType } : {}),
          ...(ev.title ? { title: ev.title } : {}),
          ...(ev.detail ? { detail: ev.detail } : {}),
          ...(ev.summary ? { summary: ev.summary } : {}),
        };
      }
      // Inline: if this job maps to a tool chip (subagents), decorate it in the transcript.
      const items = ev.toolUseId
        ? s.items.map((it) =>
            it.kind === 'tool' && it.toolUseId === ev.toolUseId
              ? { ...it, ...(ev.status ? { status: ev.status } : {}), ...(ev.taskType === 'subagent' && ev.title ? { subagentType: ev.title } : {}), ...(ev.summary ? { summary: ev.summary } : {}) }
              : it,
          )
        : s.items;
      return { ...s, tasks, items };
    });
  } else if (ev.kind === 'todo' && ev.todoId) {
    const todoId = ev.todoId;
    update(chatId, (s) => {
      const todos = { ...s.todos };
      if (ev.todoStatus === 'deleted') {
        delete todos[todoId];
      } else {
        const prev: TodoInfo = todos[todoId] ?? { id: todoId, subject: '', status: 'pending' };
        // ev.todoStatus is narrowed to TodoStatus | undefined here ('deleted' handled above).
        todos[todoId] = { ...prev, ...(ev.subject ? { subject: ev.subject } : {}), ...(ev.todoStatus ? { status: ev.todoStatus } : {}) };
      }
      return { ...s, todos };
    });
  } else if (ev.kind === 'done') {
    clearBubbles(chatId);
    update(
      chatId,
      (s) => ({
        ...s,
        busy: false,
        status: '',
        sdk: ev.sessionId ?? s.sdk,
        contextPct: ev.contextPct ?? s.contextPct,
        items: ev.error ? [...s.items, { id: nextItemId(), kind: 'msg', role: 'agent', text: `⚠ ${ev.error}` }] : s.items,
      }),
    );
    // Drain queue: fire next pending message if one was sent while agent was busy.
    const next = (sessions.get(chatId) ?? EMPTY).queue[0];
    if (next) {
      update(chatId, (s) => ({ ...s, queue: s.queue.slice(1) }));
      void dispatchSend(chatId, next.message, next.images);
    }
  }
}

/** Fire the HTTP send and update busy state. Message already in transcript. */
async function dispatchSend(chatId: string, message: string, images: PendingImage[]): Promise<void> {
  clearBubbles(chatId);
  update(chatId, (cur) => ({ ...cur, busy: true, status: 'thinking' }));
  try {
    // ADR 0004: sessionId / model / effort / fork are server-owned (ChatMeta); the body
    // carries only the turn's content.
    const res = await fetch(bridgeUrl(chatId, `/api/chat/${chatId}/send`), {
      method: 'POST',
      headers: chatHeaders(chatId, { 'content-type': 'application/json' }),
      body: JSON.stringify({ message, images: images.map(({ media_type, data }) => ({ media_type, data })) }),
    });
    // fetch only rejects on a network failure, so an HTTP error status (425 Too Early =
    // the SSE stream isn't subscribed yet; or a 5xx) lands here, NOT in catch. Without
    // this branch the card stays stuck on busy:true forever and the turn is silently
    // dropped (no `done` ever arrives to clear it). Clear busy and surface why.
    if (!res.ok) {
      // 409 turn_in_flight (ADR-0011): a turn IS running server-side (this tab raced the
      // guard — a headless run or another tab's turn). Not an error: park the message on
      // the queue (it drains on the turn's done frame) and stay busy, mirroring the local
      // queue path exactly.
      if (res.status === 409) {
        update(chatId, (cur) => ({ ...cur, busy: true, status: cur.status || 'working', queue: [...cur.queue, { message, images }] }));
        return;
      }
      const why = res.status === 425 ? 'chat connection not ready, resend in a moment' : `send failed (${res.status})`;
      update(chatId, (cur) => ({ ...cur, busy: false, status: '', items: [...cur.items, { id: nextItemId(), kind: 'msg', role: 'agent', text: `⚠ ${why}` }] }));
    }
  } catch {
    update(chatId, (cur) => ({ ...cur, busy: false, status: '' }));
  }
}

/** Interrupt the in-flight turn (Esc / Stop). Drops any queued sends so they don't
 *  fire after the stop; `busy` clears when the server's `done` echo arrives. */
export async function interrupt(chatId: string): Promise<void> {
  const s = sessions.get(chatId);
  if (!s || !s.busy) return;
  if (s.queue.length) update(chatId, { queue: [] });
  try {
    await fetch(bridgeUrl(chatId, `/api/chat/${chatId}/interrupt`), { method: 'POST', headers: chatHeaders(chatId) });
  } catch {
    /* ignore */
  }
}

/** Send a user turn. Queues automatically if a turn is already in progress. */
export async function send(chatId: string, message: string, images: PendingImage[]): Promise<void> {
  const s = sessions.get(chatId) ?? EMPTY;
  if ((!message && images.length === 0) || !s.subscribed) return;
  // Always add user message to transcript immediately.
  const uid = nextItemId();
  update(chatId, (cur) => ({
    ...cur,
    items: [...cur.items, { id: uid, kind: 'msg', role: 'user', text: message, images: images.length ? images.map((p) => p.dataUrl) : undefined }],
  }));
  if (s.busy) {
    // Queue for after current turn completes.
    update(chatId, (cur) => ({ ...cur, queue: [...cur.queue, { message, images }] }));
    return;
  }
  void dispatchSend(chatId, message, images);
}
