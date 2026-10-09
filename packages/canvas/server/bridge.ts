// The bridge: a single Bun process that runs the agent, serves the component library and
// the chat plane, and writes into canvas ROOMS. Since ADR-0019 the canvas document is not
// here at all: it lives in the canvas's Durable-Object-hosted TLSocketRoom, browsers read
// and write it over the sync WebSocket, and this process opens a short-lived store on the
// room for the duration of one write (`inRoom`). One source of truth — the room.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import type { CanvasState } from '../src/shapes.ts';
import { bumpAllComponents, createShapesOp, nextComponentRev, placeComponentOp, readImageOp, updateShapesOp } from '../src/canvas-ops.ts';
import type { OpResult } from '../src/canvas-ops.ts';
import { shapesOnPage } from '../src/current-page.ts';
import { canvasAssetFetcher, canvasRoomOpener } from './canvas-room.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';
import { BlobStore, selectBackend } from './blob-store.ts';
import { type CanvasSubscriber, type ScreenshotChannel, createScreenshotChannels } from './screenshot-channel.ts';
import { createChatHub } from './chat-hub.ts';
import { sseComment } from './sse.ts';
import { ChatMetaStore } from './chat-meta.ts';
import { PersistSink } from './persistable.ts';
import { loadSessionTranscript } from './session-transcript.ts';
import type { PlatformRpc } from './platform-rpc-client.ts';
import { isLocalhostEdge, loadWebPocEnv, platformRpcFromEnv } from './platform-rpc-env.ts';
import { LOCAL_DEV_PLATFORM_SECRET } from '../shared/platform-rpc.ts';
import { type Notify, openConversation, placeChatCard } from './inbox.ts';
import { INBOX_ASSIGN_HEADER } from '../shared/chat-wire.ts';
import {
  BRIDGE_ROUTES,
  CANVAS_ID_HEADER,
  CANVAS_VIEWER_HEADER,
  CreateShapesBody,
  DEV_AGENT_GIT_TOKEN_HEADER,
  DEV_AGENT_REPO_HEADER,
  DeleteShapesBody,
  EditComponentBody,
  GUEST_CANVAS_HEADER,
  GUEST_CAPS_HEADER,
  HEADLESS_SEND_HEADER,
  HUDDLE_AGENT_TOKEN_HEADER,
  HUDDLE_CANVAS_HEADER,
  INBOX_CONVERSATION_HEADER,
  INBOX_PAIRING_HEADER,
  LIVEKIT_API_KEY_HEADER,
  LIVEKIT_API_SECRET_HEADER,
  LIVEKIT_URL_HEADER,
  PlaceComponentBody,
  CallComponentBody,
  type CanvasImageResult,
  SelectPageBody,
  UpdateShapesBody,
  ViewCanvasBody,
  type ViewCanvasResult,
  WriteComponentBody,
  WriteDataBody,
  decodeForwardedConversation,
  decodeForwardedPairing,
  wireError,
} from '../shared/bridge-wire.ts';
import { callComponent } from './component-commands.ts';
import { branchName, createRepoWorktreeManager } from './repo-worktree.ts';
import { refreshCheckout, removeCheckout } from './repo-checkout.ts';
import { DEV_AGENT_KIND, openDevAgentPr } from './dev-agent-workflow.ts';
import { adoptSession, TranscriptStore } from './transcript-store.ts';
import { type CanvasImage, type ChatEvent, type OpenPr, createCanvasTools, parseCanvasImages, runChat } from './agent.ts';
import { MCP_TOKENS_HEADER, McpSelectionSchema, applyMcpSelection, decodeMcpTokens, mcpDisallowedTools } from './mcp-registry.ts';
import { adoptFromShared, promoteToShared } from './component-share-ops.ts';
import { editComponent, isShared, listComponentDetails, readComponent, writeComponent, writeDataFile } from './components.ts';
import { readGuestCapabilities, type GuestCapabilities } from '../shared/guest-capabilities.ts';
import { type TurnDeps, runTurn } from './turn.ts';
import type { ChatFrame } from '../shared/chat-wire.ts';
import { SkillName, UploadSkillInput } from '../shared/skills-wire.ts';
import { materializeSkills, writeSkill } from './skills.ts';
import { CAPTURE_ROOT, listCaptures, saveCapture } from './capture.ts';
import { createHuddleSupervisor } from './huddle-supervisor.ts';

// Build stamps: scripts/deploy.sh writes both files right before the image build, so the
// running container reports exactly what it is. The deploy then polls until they match —
// turning "is the new code live?" from a guess into a deterministic check. Both are "dev"
// locally (files absent, and both are gitignored).
//
// Two stamps, two questions (ADR-0025). BUILD_REV is the git SHA — the operational truth,
// precise to the commit. VERSION is the released semver — the communication truth, and what
// a tag claims went live. A release makes them 1:1; between releases only BUILD_REV moves.
const stamp = async (file: string) =>
  (await Bun.file(fileURLToPath(new URL(file, import.meta.url)))
    .text()
    .catch(() => '')).trim() || 'dev';
const BUILD_REV = await stamp('./build-rev.txt');
const VERSION = await stamp('./version.txt');

const PORT = Number(process.env.CANVAS_BRIDGE_PORT ?? 4511);

/** Process start, for /api/status `uptimeMs` — it used to ride on the canvas save-health
 *  record, which went with the sync plane (#297). */
const BOOT_AT = Date.now();

// --- platform env ----------------------------------------------------------
// The platform data layer's env — since ADR-0018 / #266 that means just the two values the
// PLATFORM RPC needs (its edge origin and the shared trust root the bearer derives from). The
// container gets them as real process.env; local dev reads them from web-poc/.dev.vars, the
// same file `wrangler dev` loads for the edge Worker, so both ends of the hop agree.
//
// web-poc's own Hono app is NOT mounted here any more. The Notebook has been served at the
// EDGE since ADR-0007 / #56; this mount was reachable only when something talked to the bridge
// directly, i.e. local dev — and #263 put the edge Worker into the dev loop, which is where
// `/v1/*` and `/api/auth/*` are served from now.
// (`loadWebPocEnv` and the RPC wiring live in `platform-rpc-env.ts` since the vite dev server
// needs the same hop for on-demand Component materialization — ADR-0022.)
const webPocEnv = loadWebPocEnv();

// Inbox (#61): the bridge is a single-user localhost surface, so the inbox owner + platform
// workspace come from env (the authenticated-user wiring is a platform/#62 concern).
const INBOX_USER = process.env.CANVAS_USER ?? 'default';
// The platform RPC (ADR-0018 / #266): the container's ONLY path back into the platform data
// layer. There is no local client behind it any more — this bridge constructs no database
// client, holds no connection string, and is handed no credentials (worker/container-env.ts).
// Null when unconfigured, which is now a DEGRADED bridge rather than one with a fallback: the
// chat-lifecycle writes are best-effort by contract, so a turn still runs, streams, persists to
// R2 and answers the human; it just does not file its Inbox row.
//
// The local-dev fallback secret applies ONLY to a localhost edge: a fresh worktree has no
// `web-poc/.dev.vars`, and without a shared trust root the dev loop would 401 silently rather
// than obviously. A real `.dev.vars` (and the container's real env) always wins.
const platformRpcClient = platformRpcFromEnv(webPocEnv);
if (!platformRpcClient) console.warn('[inbox] no platform RPC configured — Inbox rows will not be filed for this bridge');
// #87: the real attention signal. Web push (shell/src/push.ts → worker/push.ts →
// push_subscriptions), logged either way. Delivery itself now runs at the EDGE (it reads the
// subscription rows and prunes dead endpoints), so the container asks for it by name and never
// learns who is subscribed. #231: recipients follow the Conversation's assignment — the assignee
// alone, or the whole workspace roster when nobody has claimed it — resolved edge-side.
const notify: Notify = async (conversationId, question) => {
  console.log(`[inbox] waiting_on:human conv=${conversationId} q=${question.slice(0, 80)}`);
  await platformRpcClient?.notify({ conversationId, question });
};


// Workspace blob storage: local disk in dev, R2 in the container (selected by env). It no
// longer holds canvas state — ADR-0019 / #297 deleted that writer, and the retained
// `canvas-state.json` blobs are read only by the cutover script (#295). Nor workspace
// content: the tarballs went with their sinks in #366 and Components, data files and skills
// are Records in D1. What is left here is chat meta, per-session transcripts, and marts.
const WORKSPACE = process.env.CANVAS_WORKSPACE ?? 'default';
const DEFAULT_CANVAS_ID = process.env.CANVAS_ID ?? 'default';
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
// Capture the raw backend too: the Inbox transcript backup/restore (#60/#61) keys blobs by
// sessionId (transcript-store), so it needs the low-level get/put seam, not BlobStore's canvas API.
const blobBackend = selectBackend(`${PKG_ROOT}.persist`);
const blobStore = new BlobStore(blobBackend);

// Per-canvas screenshot channels, keyed by canvasId — the only thing left of the old
// per-canvas session (ADR-0019 / #297). The store, its R2 persistence and the full-state
// SSE broadcast are gone; a canvas's document lives in its room. The browser still selects
// a canvas via the `x-canvas-id` header (or `?canvas=`); absent → the default.
// (The lazy canvas-edge backfill that used to run here went with the container's database in
// ADR-0018 / #266. It was a one-time migration for chats born before edge capture existed, it
// has long since run everywhere, and the live path — `findOrCreateConversation`'s first-wins
// canvas edge, at the edge — still fills a null edge on the chat's next turn.)
const screenshotChannels = createScreenshotChannels();
function canvasIdFrom(req: Request, url: URL): string {
  return req.headers.get(CANVAS_ID_HEADER) ?? url.searchParams.get('canvas') ?? DEFAULT_CANVAS_ID;
}

/**
 * The bridge's view of a guest (#320): the capabilities the EDGE decided, from the one
 * derivation both doors share (`shared/guest-capabilities.ts`). Null = a member's request.
 *
 * `x-guest-canvas` is what makes a request a guest's — it is stamped on every proxied
 * guest request and cannot be spoofed upward. The capabilities are parsed here on the
 * receiving side of the boundary (CLAUDE.md §7), and anything that does not parse is NO
 * capabilities: a guest request whose grants are unreadable can do nothing, which is the
 * same answer as a link that grants nothing.
 */
function guestCapsOf(req: Request): GuestCapabilities | null {
  if (!req.headers.get(GUEST_CANVAS_HEADER)) return null;
  return readGuestCapabilities(req.headers.get(GUEST_CAPS_HEADER));
}

/** Guest write routes on this door, and the capability each needs. Anything not listed is
 *  denied to a guest outright — the same default-deny shape as `worker/guest-gate.ts`, so
 *  the two doors cannot drift into authorizing different things again (#297). The canvas
 *  DOCUMENT is absent on purpose: a guest edits it on the sync socket, as themselves,
 *  never through a route this process would author on their behalf. */
function guestMayWrite(caps: GuestCapabilities, path: string, method: string): boolean {
  const source = /^\/api\/components\/([^/]+)$/.exec(path);
  if (method === 'PUT' && source && !['promote', 'adopt', 'place'].includes(source[1] as string)) return caps.editSource;
  return false;
}

// Per-chat durable state (ADR 0004): server-owned { sessionId, model, effort, forkNext },
// the single home that replaces browser localStorage. Persisted via blobStore (local disk
// in dev so a reload rehydrates; R2 in the container). Config is not data-loss-critical, so
// a load error just starts empty.
const chatMeta = new ChatMetaStore(blobStore, WORKSPACE);
try {
  await chatMeta.load();
} catch (err) {
  console.error('[chatmeta] load failed; starting empty:', err);
}

const SESSIONS_DIR = `${process.env.HOME ?? '/root'}/.claude/projects`;
// #356: session Transcripts are FILES (CONTEXT.md → Record vs File) — one opaque object per
// session, NOT a tar of this dir. The store is the only thing that reads or writes them: a turn
// puts the one session it touched, a resume fetches the one session it needs, boot fetches none.
const transcripts = new TranscriptStore(blobBackend, SESSIONS_DIR);

// THE TARBALL SINKS ARE GONE (#366, ADR-0022). `shared-components`, `canvas-dirs` and `skills`
// each tarred a directory tree over ONE R2 key at turn completion — a full replace, which made
// every flush the write half of a read-modify-write whose read happened at boot. On 2026-07-29
// a boot that restored nothing flushed an empty tree over the only copy and destroyed every
// own-tier Component, every custom handler and every workspace skill at once. The empty-archive
// guard that shipped after it went too, because it guarded a write path that no longer exists:
// Components, their data files and Workspace skills are Records in D1, written one row at a
// time through the platform RPC, and the filesystem is a rendering of them.
//
// `chatMeta` is the one Persistable left, and it is not workspace content: it is the per-chat
// `{sessionId, model, effort}` map, written whole as JSON rather than snapshotted off a
// directory, so an empty source tree is not a state it can have. The sink stays for it — the
// health it reports at /api/status is what makes a silent save failure visible, which is the
// class of bug that hid the dead sessions watcher.
const sink = new PersistSink();
sink.register(chatMeta.persistable());

/** ADR 0003 turn-completion batch — chatMeta, in dev and prod alike, for resume and
 *  cross-device rehydrate. Nothing else: Records persist at author time through their own
 *  write path (a store failure fails the tool call), and the turn's Transcript is put as one
 *  object after settle — see `turnDeps.backupTranscript`. */
async function onTurnComplete(): Promise<void> {
  await sink.flush('chatMeta');
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The canvas SSE stream, reduced to the screenshot round-trip (#297): the document travels
 *  over the sync WebSocket now, so this carries `screenshot` frames and nothing else. It
 *  opens with a comment frame rather than a state prime — there is no state here to prime. */
function canvasStream(channel: ScreenshotChannel, viewer: string | null): Response {
  const clients = channel.clients;
  let self: CanvasSubscriber;
  const stream = new ReadableStream({
    start(controller) {
      // The subscriber record — not the bare controller — is what the set holds now, so a
      // `page` frame can be addressed at one person. `viewer` is whatever the edge stamped
      // and null for a guest; see CANVAS_VIEWER_HEADER.
      self = { controller, viewer };
      clients.add(self);
      markAlive();
      ensureReaper();
      controller.enqueue(sseComment('subscribed')); // opens + flushes the stream
    },
    cancel() {
      clients.delete(self);
      console.log(`[clients] canvas ${channel.canvasId} stream cancel -> canvas=${clients.size} chat=${chatHub.subscriberCount()}`);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
}

/** The chat plane (server/chat-hub.ts): the one multiplexed SSE subscriber set, the
 * chat→canvas binding + guest-chat ownership the #220 confinement guards consult, and the
 * turn abort plane. Exported so tests drive the seam through the hub instead of scrubbing
 * module singletons — the canvas plane's `canvasSessions`, for the chat side. */
export const chatHub = createChatHub();

// --- idle liveness: why the CF container can sleep ---
// A browser holds SSE streams open; the sandbox's per-forward inflight hold keeps the
// container awake for as long as each forward is open. The CF preview-proxy never
// propagates a client disconnect to the container, and the forward's inflight hold
// does NOT release when we close/error the stream from here either (proven via bootAt:
// the hold sticks whether the client is gone or still connected). So the container
// cannot idle-sleep on its own while any tab has ever opened a stream. Instead the
// client POSTs /api/alive while its streams are open; when no beat lands within
// STALE_MS there's no live tab, and the reaper exits the process (see ensureReaper) —
// which stops the container. STALE_MS must exceed the client's beat interval (BEAT_MS)
// with margin — 90s tolerates ~2 missed 30s beats (blips). Override via env.
const STALE_MS = Number(process.env.CANVAS_STREAM_STALE_MS ?? 90_000);
let lastAlive = Date.now();
let reaper: ReturnType<typeof setInterval> | null = null;
function markAlive(): void {
  lastAlive = Date.now();
}
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    if (Date.now() - lastAlive <= STALE_MS) return; // a live tab beat recently — stay warm
    // No heartbeat for STALE_MS => no live browser. The sandbox CANNOT sleep while our
    // SSE forwards are open, and their teardown never reaches the container: the CF
    // preview-proxy doesn't propagate a client disconnect, and closing/erroring from
    // our side doesn't settle the forward either (proven — the DO's inflight hold
    // sticks, so it never idles). The one lever we have is to exit: dev.ts and
    // container-start exit with us, CF stops the container, and the next request
    // cold-boots. Nothing is flushed on the way out any more (#297): canvas state lives in
    // the room, which the Durable Object persists, so an exit here loses nothing.
    if (reaper) {
      clearInterval(reaper);
      reaper = null;
    }
    // Only self-exit inside the CF container (where it maps to container sleep). In
    // local dev there is nothing to sleep, so never kill the developer's dev server.
    if (!process.env.IS_SANDBOX) return;
    console.log(`[idle] no client heartbeat for ${STALE_MS}ms -> exit so the container can sleep`);
    process.exit(0);
  }, 10_000);
}

function broadcastChat(chatId: string, ev: ChatEvent): void {
  // Build the on-wire frame through the shared type, so a new ChatEvent kind added
  // in only one place fails the build here until the frame shape accounts for it.
  // The hub owns the fan-out (subscribers, the guest filter, dead-controller cleanup).
  chatHub.broadcast({ chatId, ...ev } satisfies ChatFrame);
}

/** Test seam (#220): drive the shared chat broadcast directly to pin the guest filter. */
export const broadcastChatEvent = broadcastChat;

/** Subscribe to ALL chats' events (SSE), one stream per client. Subscribe BEFORE sending.
 * A guest subscription (#220) registers with its canvas so broadcastChat filters frames. */
function chatStream(guestCanvas?: string): Response {
  let self: ReadableStreamDefaultController;
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      chatHub.subscribe(controller, guestCanvas);
      markAlive();
      ensureReaper();
      controller.enqueue(sseComment('subscribed')); // comment frame: opens + flushes the stream
      // Heartbeat: keeps the connection from going idle-dead during a long silent think, and
      // a closed socket (bridge died) trips EventSource.onerror on the client -> "reconnecting".
      ping = setInterval(() => {
        try {
          controller.enqueue(sseComment('ping'));
        } catch {
          clearInterval(ping);
          chatHub.unsubscribe(controller);
          console.log(`[clients] chat ping dead-controller -> chat=${chatHub.subscriberCount()} canvas(default)=${screenshotChannels.get(DEFAULT_CANVAS_ID).clients.size}`);
        }
      }, 15000);
    },
    cancel() {
      clearInterval(ping);
      chatHub.unsubscribe(self);
      console.log(`[clients] chat stream cancel -> chat=${chatHub.subscriberCount()} canvas(default)=${screenshotChannels.get(DEFAULT_CANVAS_ID).clients.size}`);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
}


/** ADR-0011 / ADR-0010 6a: the edge-minted token header is the COMPLETE definition of a
 * dev-agent turn. Beyond the worktree + open_pr (prepareDevAgentTurn), it decides:
 *   - the Conversation KIND the turn files under — 'dev-agent', so the row-at-start upsert
 *     and any end_turn land as dev-agent Conversations (which is exactly what the edge's
 *     per-send token mint keys on; a 'chat'-kinded row would never re-arm). The rows live
 *     in the bridge's own workspace — dev-agent is a session type, not a workspace;
 *   - the skill policy (ADR-0013) — a chat turn gets every platform + workspace skill
 *     (server/skills.ts chatSkillSources — two plugin areas, nothing else), while a token-bearing dev-agent turn
 *     keeps a pinned list so a planted workspace skill can never ride an allowlisted name
 *     into a turn that holds a git token. */
export function turnFlavor(devAgentGitToken: string | undefined): { workspaceId: string; kind: 'chat' | 'dev-agent'; skills?: string[] } {
  return devAgentGitToken
    ? { workspaceId: WORKSPACE, kind: DEV_AGENT_KIND, skills: ['impeccable', 'tdd', 'improve-codebase-architecture'] }
    : { workspaceId: WORKSPACE, kind: 'chat' };
}

/** ADR-0011 row-at-start: a session enters the Inbox index the moment the SDK assigns its id
 * (the turn's `init` event), landing in waiting_on:none — visible live in "All", never
 * cluttering "Needs me". Also seeds ChatMeta right away so `chatIdForSession` resolves this
 * chat MID-turn (opening the running Conversation attaches to this chat's live stream).
 * Idempotent (find-or-create by chat, rebinding the newest sessionId) and
 * best-effort — an index failure never fails the turn.
 *
 * ADR-0018: this write ORIGINATES in the container, so the row is filed over the platform
 * RPC's `conversation.start` operation. Since #266 there is no local client behind it. The
 * best-effort contract is unchanged — the hop can fail exactly as the write could, and the
 * turn continues. */
export async function indexSessionStart(chatId: string, sessionId: string, message: string, workspaceId: string = WORKSPACE, canvasId?: string, kind?: 'chat' | 'dev-agent', repo?: string, assignTo?: string, deps: { rpc: PlatformRpc | null } = { rpc: platformRpcClient }): Promise<void> {
  if (chatMeta.get(chatId).sessionId !== sessionId) chatMeta.set(chatId, { sessionId });
  if (canvasId) chatHub.bindCanvas(chatId, canvasId); // #220: the guest stream filter's binding
  const input = {
    sessionId,
    userId: INBOX_USER,
    workspaceId,
    kind,
    ownerRef: chatId,
    canvasId,
    repo,
    summary: message.slice(0, 200),
    assignTo,
  };
  await (deps.rpc?.conversationStart(input) ?? Promise.resolve()).catch((err) =>
    console.error('[inbox] session-start row upsert failed:', err),
  );
}

/** The dev-agent turn context (ADR-0010): armed iff the edge minted a git token for this
 * send — which it does only for a dev-agent Conversation. The token rides the request
 * (never env, never persisted), so "dev-agent-ness" is a property of the Conversation, not
 * of the container this bridge runs in. No token ⇒ undefined — every product turn stays
 * exactly as it was.
 *
 * The turn runs against a PREPARED worktree, never the live tree (slice 6): the baked image
 * is not even a git repo, and CANVAS_CWD is the vite-watched app tree a commit must never
 * touch. `ensureWorktree` clones the hub under `${CANVAS_CWD}/.dev-agent` and adds (or, on a
 * later turn of the same chat, reuses — edits intact) a worktree off origin/main on a branch
 * keyed by the dev-agent tag + chatId. The SDK turn gets `cwd = worktree.path`, so the
 * agent's edits land in the checkout `open_pr` commits; and since the SDK's resume is
 * cwd-scoped (#133), the session's JSONL is adopted (moved) into the worktree's project dir
 * first. The manager gets the token via config so nothing reads process.env. */
export interface DevAgentTurn {
  openPr: OpenPr;
  cwd: string;
}
export async function prepareDevAgentTurn(
  token: string | undefined,
  repo: string | undefined,
  chatId: string,
  sessionId: string | null,
  // Default-parameter test seam: production always uses the real git manager + adopt + RPC.
  deps: { manager: typeof createRepoWorktreeManager; adopt: typeof adoptSession; rpc?: PlatformRpc | null } = {
    manager: createRepoWorktreeManager,
    adopt: adoptSession,
    rpc: platformRpcClient,
  },
): Promise<DevAgentTurn | undefined> {
  // Both the token AND the repo come from the edge (ADR-0015): a token without a target
  // repo cannot arm open_pr. Per-repo hub dirs keep multi-repo workspaces' clones apart.
  if (!token || !repo) return undefined;
  const git = deps.manager({ repo, workspaceRoot: `${CANVAS_CWD}/.dev-agent/${repo.replace('/', '__')}`, token });
  const worktree = await git.ensureWorktree(branchName(DEV_AGENT_KIND, chatId));
  if (sessionId) await deps.adopt(SESSIONS_DIR, sessionId, worktree.path);
  const openPr: OpenPr = async (input) => {
    const url = await openDevAgentPr({ git, worktree }, input);
    if (!url) return 'Nothing to commit — the worktree is clean. Make your edits first, then call open_pr again.';
    // CONTEXT.md "Open PR": the url is the run's durable artifact, so it becomes Conversation
    // state rather than only a line in the transcript — that is what lets the Inbox offer to
    // merge it. Names the CHAT, never the row (ADR-0018), and best-effort like every other
    // RPC call site: a failed report must never fail a turn whose PR is already open.
    await deps.rpc
      ?.conversationPrOpened({
        sessionId: chatMeta.get(chatId).sessionId ?? sessionId ?? chatId,
        userId: INBOX_USER,
        workspaceId: WORKSPACE,
        kind: DEV_AGENT_KIND,
        ownerRef: chatId,
        repo,
        prUrl: url,
      })
      .catch((err) => console.error('[dev-agent] open_pr: reporting the PR edge-ward failed:', err));
    return `Opened PR: ${url}`;
  };
  return { openPr, cwd: worktree.path };
}

/** Settle-time Conversation upsert (the finally-block backstop): every settled turn marks
 * activity (unread + touch) so the session surfaces in the Inbox "All" view even when the
 * end_turn gate was bypassed (ungated stop, error turn). Idempotent by CHAT (ownerRef; resume
 * mints a new sessionId per turn, so the chat is the identity and the row is re-pointed at the
 * newest session). The turn awaits the row-at-start index first (see TurnDeps.indexSession), so
 * this find-or-create finds the one row instead of racing it into a duplicate. Best-effort.
 *
 * ADR-0018 / #266: the find-or-create-and-mark-active pair is ONE named operation at the edge
 * (`conversation.settle`) — the container has no client to make it with, and splitting it into
 * two hops would let a turn land a row it then failed to mark. */
async function settleConversation(input: { chatId: string; sessionId: string; message: string; workspaceId: string; canvasId?: string; kind?: 'chat' | 'dev-agent'; repo?: string }): Promise<void> {
  await (
    platformRpcClient?.conversationSettle({
      sessionId: input.sessionId,
      userId: INBOX_USER,
      workspaceId: input.workspaceId,
      kind: input.kind,
      ownerRef: input.chatId,
      canvasId: input.canvasId,
      repo: input.repo,
      summary: input.message.slice(0, 200),
    }) ?? Promise.resolve()
  ).catch((err) => console.error('[inbox] session-row upsert failed:', err));
}

/**
 * E2E shim (.claude/skills/worktree — "shim only what blocks e2e"). The one thing a spec cannot
 * drive is the Claude SDK turn itself: it needs a real OAuth token and a real model round-trip.
 * Under `E2E_MODE=1` (exported by scripts/with-worktree-port.sh, and only outside production)
 * the SDK call is replaced by a turn that emits the two events the Inbox path keys on — `init`
 * with a session id, then `done`. Everything after that is the REAL pipeline: the row-at-start
 * index, the settle-time upsert, the transcript backup. Nothing else is stubbed.
 */
const E2E_MODE = process.env.NODE_ENV !== 'production' && process.env.E2E_MODE === '1';
async function* e2eRunChat(...args: Parameters<typeof runChat>): AsyncGenerator<ChatEvent> {
  const [store, message] = args;
  const sessionId = `e2e-session-${crypto.randomUUID()}`;
  yield { kind: 'init', sessionId };
  // #310 shim: a message `draw:<marker>` makes the stub agent draw TWO notes in TWO separate
  // tool calls, seconds apart, through the REAL create_shapes handler — so an e2e spec can
  // watch the first note appear in a browser while the turn is still running (the progressive
  // claim), not only after it settles. Only the model's decision to call the tool is faked.
  const marker = /^draw:(\S+)$/.exec(message.trim())?.[1];
  if (marker) {
    const create = createCanvasTools(store).find((t) => t.name === 'create_shapes')!;
    for (const [i, suffix] of ['a', 'b'].entries()) {
      const r = (await create.handler({ shapes: [{ type: 'note', x: 100 + i * 300, y: 100, text: `${marker}-${suffix}` }] } as never, undefined as never)) as {
        content: Array<{ text?: string }>;
        isError?: boolean;
      };
      // A commit failure comes back as the tool's OWN error result — surface it as the turn's
      // error rather than reporting a cheerful done over an unchanged canvas.
      if (r.isError) {
        yield { kind: 'done', sessionId, costUsd: 0, error: r.content[0]?.text ?? 'canvas write failed' };
        return;
      }
      if (suffix === 'a') await Bun.sleep(4000);
    }
  }
  yield { kind: 'done', sessionId, costUsd: 0 };
}

/** The turn's collaborators, each bound to its singleton. `runChatTurn` (below) turns a request
 * into a `TurnInput` and hands it here; `server/turn.ts` owns the phase order. */
const turnDeps: TurnDeps = {
  aborters: chatHub.aborters,
  flavor: turnFlavor,
  // The agent's view_canvas round-trip, over the canvas's screenshot SSE channel (#297).
  requestScreenshot: (canvasId) => screenshotChannels.get(canvasId).requestScreenshot,
  selectPage: (canvasId) => screenshotChannels.get(canvasId).selectPage,
  // #310: the chat agent draws into the room, like every other canvas write since #305.
  // Indirected through the mutable `openCanvasRoom` so `setCanvasRoomOpener` swaps it in tests.
  openCanvasRoom: (canvasId) => openCanvasRoom(canvasId),
  // Lambda, not the binding: `canvasAssetFetcherFor` is declared below this object.
  fetchAsset: (canvasId) => canvasAssetFetcherFor(canvasId),
  defaultCanvasId: DEFAULT_CANVAS_ID,
  // ADR-0022 / #361: render the workspace's skill Records to `.claude/skills/` before the SDK
  // scans it. Every turn flavor, deliberately: the tree the boot restore used to produce was
  // flavor-independent too, and a dev-agent turn's protection is its PINNED skill list
  // (turnFlavor), not the absence of the files.
  materializeSkills: () => materializeSkills(),
  prepareDevAgent: (token, repo, chatId, sessionId) => prepareDevAgentTurn(token, repo, chatId, sessionId),
  runChat: E2E_MODE ? e2eRunChat : runChat,
  broadcast: broadcastChat,
  inbox: { rpc: platformRpcClient, userId: INBOX_USER, notify },
  indexSession: indexSessionStart,
  stampSession: (chatId, sessionId) => chatMeta.set(chatId, { sessionId }),
  onTurnComplete,
  settleConversation,
  // Inbox (#60/#61): mirror the transcript to R2 keyed by sessionId so the Inbox can render
  // history and resume can restore it while the runner sleeps. Best-effort — never fails a turn.
  backupTranscript: (sessionId) =>
    transcripts.put(sessionId).catch((err) => console.error('[inbox] transcript backup failed:', err)),
  // #356: boot downloads no transcripts, so a resumed turn fetches its OWN session — one object,
  // at the moment it is needed. Deliberately NOT `.catch`ed: a failed fetch must fail the turn
  // rather than let the agent resume with no history and answer as if there were none.
  materializeTranscript: (sessionId) => transcripts.materialize(sessionId, CANVAS_CWD),
  sendToChat: (targetChatId, message, canvasId) => sendToChat(targetChatId, message, canvasId),
  listMarts: () => blobStore.listMarts(WORKSPACE),
};

/** Cross-chat messaging (the agent's send_message tool): post into another chat card's
 * thread and kick its turn — the same dispatch the human's /send uses, minus the wire
 * concerns (subscriber gate, guest gates: an agent-initiated send is member-context by
 * construction). One turn per chat still holds: an in-flight target refuses delivery.
 * Exported for tests (paired with setChatTurnDispatcher). */
export function sendToChat(targetChatId: string, message: string, canvasId?: string): { ok: true } | { ok: false; error: string } {
  if (chatHub.busy(targetChatId)) return { ok: false, error: 'that chat has a turn in flight — try again after it settles' };
  const meta = chatMeta.get(targetChatId);
  const effort = meta.effort && meta.effort !== 'default' ? meta.effort : undefined;
  // The SENDER's canvas routes the turn (the target card was validated against that store);
  // the recycled-away hub canvas binding is the fallback, not the source of truth.
  dispatchChatTurn(targetChatId, message, meta.sessionId, [], meta.model, false, effort, canvasId ?? chatHub.canvasOf(targetChatId));
  return { ok: true };
}

// Test seam: swap the turn's agent (`turnDeps.runChat`) on the live deps object. The
// canvas-routing test needs the REAL runChatTurn (session resolution is what it tests)
// with a fake agent — and `mock.module('./agent.ts')` can't deliver that once another
// test file has already imported this module (bun's module cache binds first, so the
// mock silently never applies and the real SDK runs). Production never calls this.
// --- the canvas room (ADR-0019, #305) -------------------------------------------------
//
// Canvas state lives in the canvas's Durable-Object-hosted sync room, not in this process:
// since #290 every browser reads from the room, so a write to the in-memory session store
// is a write nobody reads. Each write handler opens a store on the room for the duration of
// ONE call — open → mutate → flush → discard (`src/remote-store.ts`) — which is also why
// there is no cached store here to go stale behind a human's edits.
const canvasEdgeConfig = {
  origin: webPocEnv.PLATFORM_RPC_ORIGIN,
  secret:
    webPocEnv.BETTER_AUTH_SECRET ||
    (isLocalhostEdge(webPocEnv.PLATFORM_RPC_ORIGIN) ? LOCAL_DEV_PLATFORM_SECRET : undefined),
};
const productionRoomOpener = canvasRoomOpener(canvasEdgeConfig);
/** How `read_image` reaches the pixels: they live behind the edge's asset route since #290,
 *  and the container has no session, so it presents its own read-only credential (#340).
 *  Per-canvas, like the room opener above — the credential is accepted for ANY canvas, so
 *  the canvas the turn is on is what narrows it. */
const canvasAssetFetcherFor = canvasAssetFetcher(canvasEdgeConfig);
let openCanvasRoom = productionRoomOpener;

/** Test seam, as `setTurnRunChat` is: pass null to restore production. */
export function setCanvasRoomOpener(fn: ((canvasId: string) => Promise<RemoteCanvasStore>) | null): void {
  openCanvasRoom = fn ?? productionRoomOpener;
}

/**
 * Run one canvas write against the room and answer with its result.
 *
 * `flush()` is awaited BEFORE the response, and a flush failure is a 502, never a 200 with
 * a cheerful body: the mutations go one at a time, so a mid-batch failure leaves the room
 * holding a prefix of what the caller asked for, and `openRemoteCanvasStore` poisons itself
 * rather than pretend otherwise. The agent must see that as a tool error — "I drew it" over
 * an unchanged canvas is the expensive failure mode.
 *
 * An op that refuses (`OpResult.isError`) never reaches flush: nothing it queued should
 * land, and discarding the store is how that is enforced.
 */
async function inRoom(
  canvasId: string,
  // Awaited, so an op that has to reach the Record store (promote/adopt) keeps the same
  // shape as every other route: refuse before the flush, and its error is the response.
  run: (store: RemoteCanvasStore) => OpResult | Record<string, unknown> | Promise<OpResult | Record<string, unknown>>,
): Promise<Response> {
  let store: RemoteCanvasStore;
  try {
    store = await openCanvasRoom(canvasId);
  } catch (e) {
    return json({ error: `canvas ${canvasId} is unreachable: ${(e as Error).message}` }, 502);
  }
  let result: OpResult | Record<string, unknown>;
  try {
    result = await run(store);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  if (isOpResult(result) && result.isError) return json({ error: result.text }, 400);
  try {
    await store.flush();
  } catch (e) {
    return json({ error: `canvas write failed: ${(e as Error).message}` }, 502);
  }
  return json(isOpResult(result) ? { text: result.text } : result);
}

const isOpResult = (r: OpResult | Record<string, unknown>): r is OpResult => typeof (r as OpResult).text === 'string';

export function setTurnRunChat(fn: TurnDeps['runChat']): () => void {
  const prev = turnDeps.runChat;
  turnDeps.runChat = fn;
  return () => {
    turnDeps.runChat = prev;
  };
}

/** Run one turn for a chat and broadcast its events. Fire-and-forget (output is the SSE).
 * The turn runs against the session for `requestCanvasId` (the request's active canvas, #79)
 * so the agent reads/draws on the canvas the human is on; absent ⇒ the default store,
 * unchanged — BUT absence also means the turn claims no chat→canvas edge for the
 * Conversation (an inbox reply must never link a chat to the Default canvas by default).
 * `devAgentGitToken` (edge-minted, per dev-agent send) arms the `open_pr` tool for THIS turn
 * only — see prepareDevAgentTurn. The lifecycle itself lives in `server/turn.ts`. */
function runChatTurn(chatId: string, message: string, sessionId: string | null, images: CanvasImage[], model?: string, forkSession?: boolean, effort?: string, requestCanvasId?: string, devAgentGitToken?: string, mcpTokens?: Record<string, string>, devAgentRepo?: string, assignTo?: string, mcpDisallowed?: string[], viewer?: string): void {
  runTurn({ chatId, message, sessionId, images, model, forkSession, effort, canvasId: requestCanvasId, devAgentGitToken, devAgentRepo, mcpTokens, assignTo, mcpDisallowedTools: mcpDisallowed, viewer }, turnDeps);
}

// The dev-agent run's prompt — this IS the workflow now (ADR-0011: the harness dissolved
// into the agent's own turn). First sentence deliberately doubles as the Conversation row's
// title (row-at-start titles from the message). The declined-marker dedup is prompt-law; if
// discipline degrades, the designed fallback is a tool-side filter inside end_turn — never a
// resurrected harness. The ending itself is MECHANICALLY gated (ADR-0012: every turn must
// declare its ending via end_turn — needs_human or done).
// The run's policy IS this prompt (issue #184: prompt-law, no harness). The bridge.test.ts
// prompt-pin test names the load-bearing sentences — edit them consciously.
// There is no built-in task any more (#100): every run's TASK is a repo-defined job's body
// (`.claude/jobs/<name>.md`, armed by merge — ADR-0015). The architecture explore now lives
// in this repo's own `.claude/jobs/improve-codebase-architecture.md`. The wrapper below is
// still bridge code and wraps every run.
const DEV_AGENT_RUN_WRAPPER = [
  'Then read docs/adr/declined/ and DROP every candidate that matches a declined marker (human declines are final until the marker is removed).',
  [
    'Triage every surviving candidate with exactly ONE verdict:',
    '- EXECUTE, only when ALL hold: mechanical/consolidation work with no open design tension; reversible in one revert; touched behavior test-covered (or the change adds coverage); no schema, auth, deploy, or public-contract changes (absolute — never rationalize an exception); and you can write a PR decision record that lets the human verify the change without reading every line (what was found, why it is mechanical, how tests pin it) — if you cannot write that record, the candidate is a GRILL. Action: implement in this worktree, tests green, then open_pr — one PR per candidate, each PR body carrying its own decision record. Every PR must trace to a candidate found in THIS run’s explore; a PR created to have something to show is a policy violation. Executing zero is a fully successful run.',
    '- GRILL when a real design tension exists, or the EXECUTE bar fails but the finding is substantial enough to be worth the human’s attention.',
    '- DROP when it is not: record it in the decision record only (no marker — markers are reserved for HUMAN declines).',
  ].join('\n'),
  'Decline markers: when, in a later turn of this conversation, the human declines a candidate, write docs/adr/declined/<candidate-slug>.md (title, date, one-line reason, match hints) in the worktree and ship it — piggybacked on an open run PR if one exists, else as a marker-only micro-PR.',
  'Close the run with end_turn ONCE. Outcome "needs_human" only if GRILL verdicts exist (the question lists each grilled candidate: title, rationale, severity); otherwise outcome "done" — a run with nothing to grill must not ping the human, even if it executed PRs. Either way the summary carries the decision record: every candidate with verdict, one-line why, and risk class.',
].join('\n\n');

/** The run prompt: the TASK (always a repo-defined job's body) inside the platform wrapper
 * (triage law, decline markers, decision record, end_turn — ADR-0015: a job steers WHAT,
 * never under which rules). The task leads so its first sentence titles the row. */
const composeRunPrompt = (task: string): string => `${task}\n\n${DEV_AGENT_RUN_WRAPPER}`;

// #184 §4: the run turn judges (triage + implementation), so it runs on Opus; the cheap
// parallel reading is what fans out to Sonnet `explorer` subagents.
const DEV_AGENT_RUN_MODEL = 'opus';

// The in-flight dev-agent run's chatId (ADR-0011): one run at a time, with JOIN semantics —
// a kick while one runs returns the RUNNING run instead of piling up a second explore.
// Liveness is derived from the hub's aborters (the turn registry), so settling clears it naturally.
let devAgentRunChatId: string | null = null;

// Test seam: the turn dispatcher is indirected so a test can substitute a spy and
// assert that a turn was (or, on the 425 reject path, was NOT) dispatched without
// invoking the real agent SDK. Production calls runChatTurn unchanged.
let dispatchChatTurn: typeof runChatTurn = runChatTurn;
export function setChatTurnDispatcher(fn: typeof runChatTurn): () => void {
  const prev = dispatchChatTurn;
  dispatchChatTurn = fn;
  return () => {
    dispatchChatTurn = prev;
  };
}

// The cwd sessions ran under (matches agent.ts's query cwd), so transcript restore lands the JSONL
// at the exact path SDK resume reads. Restore before a resumed turn (which the SDK cwd re-derives).
const CANVAS_CWD = process.env.CANVAS_CWD ?? process.cwd();

// Huddle agent workers (ADR-0017): one child process per live voice room, spawned on the
// edge's ensure poke and reaped by its own liveness rule (exits when the last human
// leaves) — the 4h max-duration kill here is the absurdity backstop.
const huddleSupervisor = createHuddleSupervisor<{
  agentToken: string;
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
}>({
  maxDurationMs: 4 * 60 * 60 * 1000,
  spawn: (canvasId, arg) => {
    const child = Bun.spawn(['bun', resolve(import.meta.dir, 'voice-agent/main.ts')], {
      cwd: CANVAS_CWD,
      env: {
        ...process.env,
        HUDDLE_CANVAS: canvasId,
        LIVEKIT_URL: arg?.livekitUrl ?? '',
        LIVEKIT_AGENT_TOKEN: arg?.agentToken ?? '',
        LIVEKIT_API_KEY: arg?.apiKey ?? '',
        LIVEKIT_API_SECRET: arg?.apiSecret ?? '',
        BRIDGE_ORIGIN: `http://127.0.0.1:${PORT}`,
      },
      // Worker output to a per-canvas file (not 'inherit'): bridge stdout is unreadable
      // after the fact, which made every huddle failure require a foreground re-run to
      // diagnose. /tmp/huddle-<canvas>.log is tail-able by anyone in the container.
      stdout: Bun.file(`/tmp/huddle-${canvasId.replace(/[^\w-]/g, '_')}.log`),
      stderr: Bun.file(`/tmp/huddle-${canvasId.replace(/[^\w-]/g, '_')}.log`),
    });
    const exitCbs: Array<() => void> = [];
    void child.exited.then(() => {
      console.log(`[huddle] worker for ${canvasId} exited`);
      for (const cb of exitCbs) cb();
    });
    console.log(`[huddle] spawned agent worker for ${canvasId} (pid ${child.pid})`);
    return { kill: () => child.kill(), onExit: (cb) => exitCbs.push(cb) };
  },
});

// The JSONL carries no chatId, so the chatId→sessionId link lives in ChatMeta (ADR 0004). Reverse
// it to route a resumed inbox turn back to its chat card's SSE; absent (a session with no canvas
// chat home) ⇒ fall back to the conversation id so the turn still streams under a stable channel.
function chatIdForSession(sessionId: string): string | undefined {
  return Object.entries(chatMeta.snapshot()).find(([, m]) => m.sessionId === sessionId)?.[0];
}

export async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    // Liveness: any POST to /api/* means a live client is acting (drawing, chatting,
    // or an explicit heartbeat), so the reaper must not cull its streams. The client
    // beats here on a timer while its streams are open; stops when it goes idle/closes.
    if (req.method === 'POST' && path.startsWith('/api/')) markAlive();
    if (path === '/api/alive' && req.method === 'POST') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
    }

    // #320: the bridge's own guest check for the canvas + component surface, derived from
    // the SAME capabilities the edge gate used. Default-deny (`guestMayWrite` lists the
    // writes, nothing else), and deliberately redundant with the gate: these handlers write
    // to the room under the container's service credential, which is precisely what made a
    // guest's write authorize as the container in #297. Chat is not in scope here — it has
    // its own confinement below, keyed on the same header.
    const guestCaps = guestCapsOf(req);
    if (
      guestCaps &&
      req.method !== 'GET' &&
      (path.startsWith('/api/canvas/') || path.startsWith('/api/components')) &&
      !guestMayWrite(guestCaps, path, req.method)
    ) {
      return json({ error: 'guest_not_permitted' }, 403);
    }

    // Huddles (ADR-0017): the edge join flow pokes here to ensure the agent worker for a
    // canvas's voice room. The agent's room token arrives edge-minted in a header (signing
    // keys never enter the container); single-flight per canvas via the supervisor.
    if (path === '/api/huddle/ensure' && req.method === 'POST') {
      const canvasId = req.headers.get(HUDDLE_CANVAS_HEADER);
      const agentToken = req.headers.get(HUDDLE_AGENT_TOKEN_HEADER);
      const livekitUrl = req.headers.get(LIVEKIT_URL_HEADER);
      if (!canvasId || !agentToken || !livekitUrl) return json({ error: 'missing huddle headers' }, 400);
      const { joined } = huddleSupervisor.ensure(canvasId, {
        agentToken,
        livekitUrl,
        // Inference credentials (documented custody deviation — see worker/huddle.ts).
        apiKey: req.headers.get(LIVEKIT_API_KEY_HEADER) ?? '',
        apiSecret: req.headers.get(LIVEKIT_API_SECRET_HEADER) ?? '',
      });
      return json({ ok: true, joined });
    }

    // (The in-process web-poc mount that served `/v1/*` and `/api/auth/*` here went with the
    // container's database in ADR-0018 / #266. Both are EDGE routes — the Notebook API since
    // ADR-0007 / #56, and local dev since #263 runs the edge Worker, where vite proxies them.)

    // --- canvas ---
    // Every canvas route resolves its canvasId from the request (x-canvas-id header /
    // ?canvas=, default 'default') and opens the ROOM for it. Since #297 there is no
    // per-canvas state in this process at all — only the screenshot SSE channel.
    if (path === BRIDGE_ROUTES.canvas && req.method === 'GET') {
      // Reads come from the ROOM too (#305): reading the session store would answer with
      // this process's stale copy while every browser looks at a different canvas.
      try {
        const store = await openCanvasRoom(canvasIdFrom(req, url));
        const state = store.getState();
        // `?page=` narrows the answer to one page. A whole canvas is more than an agent's
        // response budget on a busy board — the failure it fixes is a read that overruns
        // the MCP limit, whose only workaround was dumping the canvas to a file. The PAGE
        // LIST is always returned in full: it is how the caller learns what to ask for.
        const page = url.searchParams.get('page') ?? undefined;
        return json({ ...state, shapes: shapesOnPage(state.shapes, state.pages ?? [], page) } satisfies CanvasState);
      } catch (e) {
        // An unknown page is the caller's mistake, not the room's — 400, with the list.
        const message = (e as Error).message;
        return json({ error: message }, message.startsWith('no page ') ? 400 : 502);
      }
    }
    // Public build stamps (#74, ADR-0025): the SHA and the released version baked into this
    // container image, and NOTHING else. deploy.sh polls this at the edge WITHOUT a session
    // to confirm a rollout is live, and a release asserts BOTH — the version is what the tag
    // claims went live, so it has to be checkable from outside. Kept separate from
    // /api/status (which exposes the turn-artifact health + client counts and stays
    // edge-gated).
    //
    // SECURITY-cs_gate sized this surface at exactly one non-sensitive field and rated it a
    // "minor info disclosure". It is now two, deliberately: a semver reveals strictly less
    // than the git SHA already served here, so the rating is unchanged. Anything beyond
    // these two belongs on the gated /api/status.
    if (path === '/api/buildrev' && req.method === 'GET') {
      return json({ buildRev: BUILD_REV, version: VERSION });
    }
    // Container health in one read. The canvas-persistence half of this (degraded, live
    // version/shape counts, save-health, unsavedVersions) went with the sync plane in #297:
    // the room persists the document, so there is no local save to be silently failing.
    if (path === '/api/status' && req.method === 'GET') {
      const canvasClients = screenshotChannels.get(canvasIdFrom(req, url)).clients;
      return json({
        buildRev: BUILD_REV,
        backend: process.env.R2_BUCKET ? 'r2' : 'fs',
        bucket: process.env.R2_BUCKET ?? null,
        // ADR 0003: the turn-completion artifacts (sessions/components/skills) report
        // health here, so a silent save failure is visible.
        artifacts: sink.healthSnapshot(),
        // Split client counts: the chat hub's subscribers are the warmth driver (their 15s
        // ping pins the container), canvasClients is pingless. Both must reach 0 for the
        // container to idle-sleep. Chat subscribers self-clean (ping enqueue throws on a dead
        // controller); canvasClients only shrinks on cancel(), so it can lag.
        clients: canvasClients.size,
        chatClients: chatHub.subscriberCount(),
        canvasClients: canvasClients.size,
        uptimeMs: Date.now() - BOOT_AT,
        at: Date.now(),
      });
    }
    // The screenshot channel (#297): `GET /api/canvas/stream` is no longer part of the sync
    // plane — it carries the agent's view_canvas ask and nothing else.
    if (path === '/api/canvas/stream' && req.method === 'GET') {
      return canvasStream(screenshotChannels.get(canvasIdFrom(req, url)), req.headers.get(CANVAS_VIEWER_HEADER));
    }
    // Ask ONE viewer's editor to switch page (never a document mutation — see SelectPageBody).
    // The viewer is the edge-stamped header, never the body: a client that could name its
    // own target could move somebody else's screen. Absent header ⇒ nobody is targeted,
    // and `asked: 0` says so rather than quietly reading as success.
    if (path === BRIDGE_ROUTES.selectPage && req.method === 'POST') {
      const parsed = SelectPageBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      const asked = screenshotChannels
        .get(canvasIdFrom(req, url))
        .selectPage(parsed.data.pageId, req.headers.get(CANVAS_VIEWER_HEADER));
      return json({ asked });
    }
    // MCP's read_image (the in-canvas agent's tool, over the wire): the same `readImageOp`
    // and the same per-canvas asset fetcher, so the container credential stays bound to
    // the canvas this request names.
    if (path === BRIDGE_ROUTES.canvasImage && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id is required' }, 400);
      const canvasId = canvasIdFrom(req, url);
      try {
        const r = await readImageOp(await openCanvasRoom(canvasId), id, canvasAssetFetcherFor(canvasId));
        if (!('image' in r)) return json({ error: r.text }, 404);
        return json(r.image satisfies CanvasImageResult);
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    }
    // MCP's view_canvas: the same browser round-trip as the in-canvas agent's. `url: null`
    // means no tab answered, which the tool reports rather than treats as a failure.
    if (path === BRIDGE_ROUTES.canvasView && req.method === 'POST') {
      const parsed = ViewCanvasBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      const shot = await screenshotChannels.get(canvasIdFrom(req, url)).requestScreenshot(parsed.data);
      return json({ url: shot } satisfies ViewCanvasResult);
    }
    if (path === BRIDGE_ROUTES.deleteShapes && req.method === 'POST') {
      const parsed = DeleteShapesBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      return inRoom(canvasIdFrom(req, url), (store) => ({ version: store.remove(parsed.data.ids) }));
    }
    // (POST /api/canvas/clear went with the sync plane in #297. It cleared the in-process
    // store, which nothing has read since #290. The agent's clear_canvas tool clears the
    // room through the same seam as every other write.)
    if (path === '/api/canvas/screenshot' && req.method === 'POST') {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const screenurl = typeof body.url === 'string' ? body.url : null;
      screenshotChannels.get(canvasIdFrom(req, url)).resolveScreenshot(id, screenurl);
      return json({ ok: true });
    }

    // --- shared component library (#55): the UI action for promote / adopt. Mirrors the
    // agent tools; each resolves the caller's canvas from the same x-canvas-id selection.
    // The hot-reload rev-bump lands in the ROOM, like every other canvas write.
    //
    // #297: the CROSS-canvas half of the shared-library fan-out is gone with the session
    // registry it fanned over. It bumped the in-memory stores of other canvases, which no
    // browser has read since #290 — so this only makes the code honest about what already
    // happened. A canvas other than the caller's re-imports a changed shared module on its
    // next load. Restoring a live cross-canvas bump needs a room-based fan-out (#320-adjacent).
    if (path === '/api/components/promote' && req.method === 'POST') {
      const canvasId = canvasIdFrom(req, url);
      const body = await readBody(req);
      const module = typeof body.module === 'string' ? body.module : '';
      return inRoom(canvasId, async (store) => ({
        ok: true,
        reloaded: await promoteToShared(canvasId, module, () => bumpAllComponents(store, nextComponentRev(store))),
      }));
    }
    if (path === '/api/components/adopt' && req.method === 'POST') {
      const canvasId = canvasIdFrom(req, url);
      const body = await readBody(req);
      const module = typeof body.module === 'string' ? body.module : '';
      return inRoom(canvasId, async (store) => ({
        ok: true,
        reloaded: await adoptFromShared(canvasId, module, () => bumpAllComponents(store, nextComponentRev(store))),
      }));
    }

    // Direct canvas mutation over the wire (MCP full access): the same ops the in-canvas
    // agent's tools call (create fills defaults, update merges the patch, place stamps the
    // component rev), minus the chat-card linking — an external client has no chat card.
    // normalizeShape (inside the ops) stays the single shape validator.
    if (path === BRIDGE_ROUTES.shapesCreate && req.method === 'POST') {
      const parsed = CreateShapesBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      return inRoom(canvasIdFrom(req, url), (store) => createShapesOp(store, parsed.data.shapes));
    }
    if (path === BRIDGE_ROUTES.shapesUpdate && req.method === 'POST') {
      const parsed = UpdateShapesBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      return inRoom(canvasIdFrom(req, url), (store) => updateShapesOp(store, parsed.data.shapes));
    }
    if (path === BRIDGE_ROUTES.componentsPlace && req.method === 'POST') {
      const parsed = PlaceComponentBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      return inRoom(canvasIdFrom(req, url), (store) => placeComponentOp(store, { ...parsed.data, rev: nextComponentRev(store) }));
    }
    if (path === BRIDGE_ROUTES.componentsCall && req.method === 'POST') {
      const parsed = CallComponentBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      const { id, command, args } = parsed.data;
      const cid = canvasIdFrom(req, url);
      return inRoom(cid, (store) => callComponent(store, cid, id, command, args));
    }

    // The component library over the wire (MCP full access): the edge MCP tools proxy
    // here — the bridge owns the container filesystem (single writer, like /api/skills).
    // Canvas-scoped via x-canvas-id; PUT mirrors the agent's write_component (write +
    // hot-reload bump + persist via the components sink).
    if (path === BRIDGE_ROUTES.components && req.method === 'GET') {
      const cid = canvasIdFrom(req, url);
      // `details` (name/description/tier) feeds the gallery; `components` stays for
      // existing consumers of the bare name list.
      // Local dev / no-edge only in practice: the EDGE answers this route now (#363) and
      // never proxies the GET here. Kept so `bun run dev` without the Worker still lists.
      const details = await listComponentDetails(cid);
      return json({ components: details.map((d) => d.name), details });
    }
    // Data files (write_data parity): non-executable siblings a component can import.
    // Same write + blunt-bump + sink-flush contract as the module PUT below.
    const dataRoute = /^\/api\/components\/data\/([^/]+)$/.exec(path);
    if (dataRoute && req.method === 'PUT') {
      const canvasId = canvasIdFrom(req, url);
      const name = decodeURIComponent(dataRoute[1] as string);
      const parsed = WriteDataBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      // The file lands (and persists) first; the hot-reload bump then goes to the ROOM, so an
      // unreachable room costs the reload, never the authored source.
      try {
        await writeDataFile(name, parsed.data.source, canvasId);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return inRoom(canvasId, (store) => ({ ok: true, name, reloaded: bumpAllComponents(store, nextComponentRev(store)) }));
    }
    const componentRoute = /^\/api\/components\/([^/]+)$/.exec(path);
    if (componentRoute && req.method === 'GET') {
      const module = decodeURIComponent(componentRoute[1] as string);
      try {
        return json({ module, source: await readComponent(module, canvasIdFrom(req, url)) });
      } catch (e) {
        return json({ error: (e as Error).message }, 404);
      }
    }
    if (componentRoute && req.method === 'PUT') {
      const canvasId = canvasIdFrom(req, url);
      const module = decodeURIComponent(componentRoute[1] as string);
      // #320: `guest_edit_source` is the OWN (canvas-scoped) tier ONLY. The accepted risk
      // is arbitrary JS in a member's browser BOUNDED TO THE INVITED CANVAS; a shared
      // module is the workspace's one source, imported by canvases the guest was never
      // invited to. The tier is filesystem state, so only this process can check it — the
      // edge gate authorized the route, not the target.
      if (guestCaps && (await isShared(module, canvasId))) return json({ error: 'guest_not_permitted' }, 403);
      const parsed = WriteComponentBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      try {
        await writeComponent(module, parsed.data.source, canvasId);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      // A shared module used to bump every open canvas; that fan-out went with the session
      // registry (#297, see promote above). The caller's canvas reloads either way.
      return inRoom(canvasId, (store) => ({ ok: true, module, reloaded: bumpAllComponents(store, nextComponentRev(store)) }));
    }

    // PATCH: the same targeted edit the in-canvas agent's `edit_component` tool makes — one
    // implementation (`editComponent`), two surfaces. It exists as its own method rather than
    // as an edge-side read-modify-write over GET+PUT so the read and the write happen in the
    // process that owns the file: one hop instead of two, and the window in which another
    // writer can slip between them shrinks to in-process.
    // Guests never arrive here: `guestMayWrite` allows PUT only, so the door above 403s a
    // guest PATCH. That is deliberate — re-opening a guest write surface is its own decision.
    if (componentRoute && req.method === 'PATCH') {
      const canvasId = canvasIdFrom(req, url);
      const module = decodeURIComponent(componentRoute[1] as string);
      const parsed = EditComponentBody.safeParse(await readBody(req));
      if (!parsed.success) return json({ error: wireError(parsed.error) }, 400);
      try {
        await editComponent(module, parsed.data.old_string, parsed.data.new_string, canvasId, parsed.data.replace_all);
      } catch (e) {
        // A missing or ambiguous anchor is the caller's mistake and its message says what to
        // do next, so it travels as a 400 rather than being flattened into a 500.
        return json({ error: (e as Error).message }, 400);
      }
      return inRoom(canvasId, (store) => ({ ok: true, module, reloaded: bumpAllComponents(store, nextComponentRev(store)) }));
    }

    // --- agent chat (multiplexed pub/sub) ---
    // GET  /api/chat/stream    — subscribe to ALL chats' events (one SSE per client)
    // POST /api/chat/:id/send  — run a turn in a chat; events broadcast (tagged) to subscribers
    if (path === '/api/chat/stream' && req.method === 'GET') {
      return chatStream(req.headers.get(GUEST_CANVAS_HEADER) ?? undefined);
    }
    // POST /api/dev-agent/run — kick one dev-agent run as a HEADLESS chat turn (ADR-0011).
    // The edge Jobs/cron handler proxies here with the freshly-minted token header; the token
    // makes it a full dev-agent turn (worktree cwd + open_pr + 'dev-agent' tag + explore
    // skill — see turnFlavor/prepareDevAgentTurn). Deliberately NOT behind the 425
    // subscribe-before-send guard: no subscriber exists by design — the session indexes at
    // init (row-at-start) and the Inbox attaches to the live stream when opened. One run at
    // a time with JOIN semantics: a kick during a run answers with the running run's chatId.
    if (path === '/api/dev-agent/run' && req.method === 'POST') {
      // A repo-defined job (#195) is the ONLY source of a run's task (#100 / ADR-0015): the
      // edge read its body off the repo's DEFAULT branch (the merge armed it) and forwards it
      // here — wrapped, never replacing the law. A jobless kick is an error, not a default run.
      const kickBody = (await req.json().catch(() => null)) as { job?: { name?: string; prompt?: string } } | null;
      const jobPrompt = typeof kickBody?.job?.prompt === 'string' && kickBody.job.prompt.trim() ? kickBody.job.prompt.trim() : undefined;
      if (!jobPrompt) {
        return json({ error: 'a dev-agent run requires a job: pick one defined in .claude/jobs/ on a selected repo’s default branch' }, 400);
      }
      if (devAgentRunChatId && chatHub.busy(devAgentRunChatId)) {
        return json({ chatId: devAgentRunChatId, joined: true }, 202);
      }
      const chatId = `dev-agent-run-${crypto.randomUUID()}`;
      devAgentRunChatId = chatId;
      // #184 §4: the whole run CONVERSATION judges on Opus — later grill replies resume
      // through the normal /send path, which reads the model from ChatMeta.
      chatMeta.set(chatId, { model: DEV_AGENT_RUN_MODEL });
      const token = req.headers.get(DEV_AGENT_GIT_TOKEN_HEADER) ?? undefined;
      // The run's target repo (ADR-0015: one run = one repo), resolved and stamped by the
      // edge next to the token. It binds the Conversation (row repo edge) and the worktree.
      const repo = req.headers.get(DEV_AGENT_REPO_HEADER) ?? undefined;
      // A MANUAL trigger's human initiator (shared inbox): the edge stamps who clicked
      // "Run now" / called run_dev_agent; a cron kick carries none ⇒ unassigned queue work.
      const runAssignTo = req.headers.get(INBOX_ASSIGN_HEADER) ?? undefined;
      // A fresh session every run (sessionId null); the run's later grill turns resume it
      // through the normal conversation path.
      dispatchChatTurn(chatId, composeRunPrompt(jobPrompt), null, [], DEV_AGENT_RUN_MODEL, undefined, undefined, undefined, token, undefined, repo, runAssignTo);
      return json({ chatId, joined: false }, 202);
    }
    // Read-only repo checkouts (ADR-0016): the edge pushes a refresh with a transient read
    // token in a header — the same custody shape as the dev-agent git token (never env,
    // never persisted; scrubbed from the on-disk origin after the op). Chat turns then read
    // the checkout under .repos/ as plain files, holding no credential.
    if (path === '/api/repos/refresh' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { repo?: string } | null;
      if (!body?.repo || !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) return json({ error: 'invalid repo' }, 400);
      const token = req.headers.get('x-repo-git-token') ?? undefined;
      try {
        const result = await refreshCheckout({ repo: body.repo, root: CANVAS_CWD, token });
        return json({ repo: body.repo, branch: result.branch, head: result.head }, 200);
      } catch (e: unknown) {
        console.error(`[repos] checkout refresh failed for ${body.repo}: ${String(e)}`);
        return json({ error: `refresh failed for ${body.repo}` }, 502);
      }
    }
    if (path === '/api/repos/checkout' && req.method === 'DELETE') {
      const body = (await req.json().catch(() => null)) as { repo?: string } | null;
      if (!body?.repo || !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) return json({ error: 'invalid repo' }, 400);
      await removeCheckout(CANVAS_CWD, body.repo);
      return new Response(null, { status: 204 });
    }
    // #177: the single writer of the workspace skills tree — the edge MCP `upload_skill`
    // proxies here. Content only (ADR-0013): plain files under .claude/skills/<name>/.
    // #361: the files are RECORDS now — `writeSkill` persists them before it touches disk, so
    // a store failure fails this call (a 500 the MCP tool reports) rather than reporting
    // success over an upload that evaporates at the next recycle. The wire contract is
    // unchanged; only where the files land moved.
    const skillRoute = /^\/api\/skills\/([^/]+)$/.exec(path);
    if (skillRoute && req.method === 'PUT') {
      const name = SkillName.safeParse(decodeURIComponent(skillRoute[1] as string));
      const body = UploadSkillInput.safeParse(await req.json().catch(() => null));
      if (!name.success || !body.success) return json({ error: 'invalid skill upload' }, 400);
      // The belt-and-braces resolve check that used to sit here moved into `writeSkill`, which
      // is where a path becomes a filesystem location — materialization needs the same guard.
      await writeSkill(name.data, body.data.files);
      return json({ ok: true, skill: name.data, files: body.data.files.length });
    }
    const chatRoute = /^\/api\/chat\/([^/]+)\/send$/.exec(path);
    if (chatRoute && req.method === 'POST') {
      const chatId = decodeURIComponent(chatRoute[1] as string);
      // Subscribe-before-send, enforced at the wire (not just the client's readiness
      // gate): the chat stream is shared — one SSE per client carries EVERY chat — so
      // "no subscriber for this chat" means no chat stream is open at all. With nobody
      // subscribed, the turn's events would broadcast into the void (there is no
      // replay), so reject early with 425 Too Early and dispatch nothing. Only a
      // race-losing / misbehaving client reaches here; the client gates on `subscribed`.
      // EXCEPT a headless send (#177: the edge MCP proxy stamps x-headless-send): like
      // /api/dev-agent/run above, no subscriber exists BY DESIGN — the caller polls
      // read_conversation instead of watching the stream, the turn persists to the
      // session JSONL regardless, and the Inbox attaches live if opened mid-turn.
      const headless = req.headers.get(HEADLESS_SEND_HEADER) === '1';
      if (!headless && chatHub.subscriberCount() === 0) return json({ error: 'no_subscribers', chatId }, 425);
      // One turn per chat, enforced at the wire (ADR-0011): a send while this chat's turn
      // runs would resume the SAME session concurrently (two SDK queries, one JSONL). The
      // client re-queues on 409 and drains on the turn's done frame; Stop-then-send is the
      // explicit way to talk over a running turn.
      if (chatHub.busy(chatId)) return json({ error: 'turn_in_flight', chatId }, 409);
      const body = await readBody(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      // Pasted screenshots: [{ media_type, data(base64) }]. Allow an image-only turn.
      const images = parseCanvasImages(body);
      if (!message && images.length === 0) return json({ error: 'message or image required' }, 400);
      // ADR 0004: sessionId/model/effort/fork are server-owned (ChatMeta), not in the body.
      const meta = chatMeta.get(chatId);
      const forkSession = chatMeta.consumeFork(chatId); // one-shot; cleared in memory now
      if (forkSession) void sink.flush('chatMeta'); // persist the clear so a recycle can't re-fork
      const effort = meta.effort && meta.effort !== 'default' ? meta.effort : undefined; // 'default' = let the model decide
      // Route the turn to the request's active canvas (#79): the agent draws on the canvas the
      // human is on (x-canvas-id / ?canvas), exactly how the canvas reads/SSE already resolve.
      // The edge-minted dev-agent git token (ADR-0010) rides a request header — set by the edge
      // chat proxy on a dev-agent Conversation's send only — and arms open_pr for this turn.
      const devAgentGitToken = req.headers.get(DEV_AGENT_GIT_TOKEN_HEADER) ?? undefined;
      // EXPLICIT canvas only (no default): the pad stamps x-canvas-id; an unaddressed send
      // (inbox thread) routes to the default store without claiming a canvas edge.
      const requestCanvasId = req.headers.get(CANVAS_ID_HEADER) ?? url.searchParams.get('canvas') ?? undefined;
      // #220 slice 6: a GUEST send (edge-stamped x-guest-canvas). Member conversations are
      // view-only — a guest may address only the link's canvas, and only chats they started
      // themselves (an established chat that isn't guest-owned is somebody else's thread).
      const guestCanvas = req.headers.get(GUEST_CANVAS_HEADER) ?? undefined;
      if (guestCanvas) {
        if (requestCanvasId !== guestCanvas) return json({ error: 'guest_canvas_mismatch', chatId }, 403);
        if (chatMeta.get(chatId).sessionId && !chatHub.isGuestChat(chatId)) {
          return json({ error: 'member_conversation_view_only', chatId }, 403);
        }
        chatHub.markGuestChat(chatId);
      }
      if (requestCanvasId) chatHub.bindCanvas(chatId, requestCanvasId);
      // ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens, set by the edge
      // proxy (worker/inbox-bridge.ts, worker/index.ts) on this send only. `server/turn.ts` drops
      // this for a dev-agent turn regardless — chat flavor only. The chat's own MCP selection
      // (ChatMeta, default all-on) then opts out: a disabled server's token is dropped here, so
      // it is never even connected; disabled tools ride as SDK disallowedTools.
      const mcpSelection = chatMeta.get(chatId).mcp;
      const mcpTokens = applyMcpSelection(decodeMcpTokens(req.headers.get(MCP_TOKENS_HEADER)), mcpSelection);
      // The dev-agent turn's target repo, stamped by the edge proxy beside the token (ADR-0015).
      const devAgentRepo = req.headers.get(DEV_AGENT_REPO_HEADER) ?? undefined;
      // The send's HUMAN INITIATOR (shared inbox, CONTEXT.md), stamped by the edge proxies:
      // assigns the Conversation at birth / claims-if-unassigned on a reply.
      const assignTo = req.headers.get(INBOX_ASSIGN_HEADER) ?? undefined;
      // WHOSE SCREEN this turn may move (presentation only — see CANVAS_VIEWER_HEADER). Read
      // separately from assignTo even though the edge stamps both from the same session: they
      // answer different questions, and only this one is allowed near a person's viewport.
      const viewer = req.headers.get(CANVAS_VIEWER_HEADER) ?? undefined;
      // Belt on top of the edge gate: a guest turn is a PLAIN chat turn on the link's canvas —
      // never a dev-agent turn, never armed with the workspace's external-MCP tokens.
      dispatchChatTurn(
        chatId,
        message,
        meta.sessionId,
        images,
        meta.model,
        forkSession,
        effort,
        requestCanvasId,
        guestCanvas ? undefined : devAgentGitToken,
        guestCanvas ? undefined : mcpTokens,
        guestCanvas ? undefined : devAgentRepo,
        assignTo,
        guestCanvas ? undefined : mcpDisallowedTools(mcpSelection),
        // A guest is never a select_page target: their per-browser identity lives in
        // localStorage and never reaches the edge, so there is no id here to match a
        // subscriber against. Explicit rather than incidental — it must stay undefined
        // even if the edge later learns to stamp something for guests.
        guestCanvas ? undefined : viewer,
      );
      return json({ ok: true }, 202);
    }
    // POST /api/chat/:id/config — update server-owned ChatMeta (model/effort/forkNext),
    // persist it, and broadcast a `config` frame so every open tab converges (ADR 0004).
    const configRoute = /^\/api\/chat\/([^/]+)\/config$/.exec(path);
    if (configRoute && req.method === 'POST') {
      const chatId = decodeURIComponent(configRoute[1] as string);
      const body = await readBody(req);
      const patch: { model?: string; effort?: string; forkNext?: boolean; mcp?: import('./mcp-registry.ts').McpSelection } = {};
      if (typeof body.model === 'string') patch.model = body.model;
      if (typeof body.effort === 'string') patch.effort = body.effort;
      if (typeof body.forkNext === 'boolean') patch.forkNext = body.forkNext;
      if (body.mcp !== undefined) {
        const sel = McpSelectionSchema.safeParse(body.mcp);
        if (!sel.success) return json({ error: 'invalid mcp selection' }, 400);
        patch.mcp = sel.data;
      }
      chatMeta.set(chatId, patch);
      await sink.flush('chatMeta');
      broadcastChat(chatId, { kind: 'config', ...patch } satisfies ChatEvent);
      return json({ ok: true });
    }
    // POST /api/chat/:id/fork — seed a forked child chat's ChatMeta from its parent
    // (server-owned, since the client no longer holds sessionId). The child resumes the
    // parent's session with a one-shot fork armed, so its first turn branches (ADR 0004).
    const forkRoute = /^\/api\/chat\/([^/]+)\/fork$/.exec(path);
    if (forkRoute && req.method === 'POST') {
      const childId = decodeURIComponent(forkRoute[1] as string);
      const body = await readBody(req);
      const parent = chatMeta.get(typeof body.from === 'string' ? body.from : '');
      chatMeta.set(childId, { sessionId: parent.sessionId, model: parent.model, effort: parent.effort, forkNext: !!parent.sessionId });
      await sink.flush('chatMeta');
      return json({ ok: true });
    }
    // GET /api/chat/:id/transcript — rehydrate on (re)connect: the JSONL-derived settled
    // transcript + the current config (ADR 0004). Pull-on-connect, per chat; the shared
    // /api/chat/stream carries only live in-flight frames.
    const transcriptRoute = /^\/api\/chat\/([^/]+)\/transcript$/.exec(path);
    if (transcriptRoute && req.method === 'GET') {
      const chatId = decodeURIComponent(transcriptRoute[1] as string);
      // #220: a guest may read only transcripts of chats bound to the link's canvas.
      // Unknown binding fails CLOSED (404 — don't confirm the chat exists).
      const guestCanvas = req.headers.get(GUEST_CANVAS_HEADER);
      if (guestCanvas && chatHub.canvasOf(chatId) !== guestCanvas) return json({ error: 'not found' }, 404);
      const meta = chatMeta.get(chatId);
      const events = meta.sessionId ? await loadSessionTranscript(SESSIONS_DIR, meta.sessionId) : [];
      // `busy`: is a turn in flight for this chat RIGHT NOW (ADR-0011)? A mid-run opener
      // missed the init frame, so rehydrate is how it learns to queue sends instead of 409ing.
      return json({ config: { model: meta.model, effort: meta.effort, forkNext: meta.forkNext, ...(meta.mcp ? { mcp: meta.mcp } : {}) }, events, busy: chatHub.busy(chatId) });
    }
    // POST /api/chat/:id/interrupt — abort the in-flight turn (Esc / Stop).
    const interruptRoute = /^\/api\/chat\/([^/]+)\/interrupt$/.exec(path);
    if (interruptRoute && req.method === 'POST') {
      const chatId = decodeURIComponent(interruptRoute[1] as string);
      // #220: a guest may stop only turns of chats THEY started — never a member's.
      if (req.headers.get(GUEST_CANVAS_HEADER) && !chatHub.isGuestChat(chatId)) return json({ error: 'not found' }, 404);
      chatHub.abort(chatId);
      return json({ ok: true });
    }

    // GET /api/inbox/:id/chat — resolve a Conversation to the chatId a Shell-mounted <ChatView>
    // subscribes to (ADR-0009 / #124). Reached ONLY through the edge proxy (/inbox/:id/bridge/*),
    // which already ownership-checked the Conversation against the gated user, FORWARDS it on
    // x-inbox-conversation, and cleared its unread (ADR-0018 / #261). Wakes THIS bridge:
    // restores the session JSONL from R2 if the container cold-booted, resolves
    // `chatIdForSession(sessionId) ?? conv.id` (a double-homed canvas chat shares its id — two live
    // views of one stream), and seeds that chatId's ChatMeta so its transcript + send resume this
    // session. The Shell then points its connection target here and renders <ChatView chatId>.
    const openConvRoute = /^\/api\/inbox\/([^/]+)\/chat$/.exec(path);
    if (openConvRoute && req.method === 'GET') {
      const id = decodeURIComponent(openConvRoute[1] as string);
      // ADR-0018 / #261: the row rides the edge's header (which also cleared unread). Parsed,
      // never trusted — an absent, malformed, or mismatched payload is the same 404 as before.
      const conv = decodeForwardedConversation(req.headers.get(INBOX_CONVERSATION_HEADER));
      if (!conv || conv.id !== id) return json({ error: `conversation not found: ${id}` }, 404);
      const { chatId } = await openConversation(
        {
          transcripts,
          cwd: CANVAS_CWD,
          chatIdForSession,
          seedChatMeta: (cid, sid) => {
            if (chatMeta.get(cid).sessionId !== sid) chatMeta.set(cid, { sessionId: sid });
          },
        },
        conv,
      );
      return json({ chatId });
    }

    // POST /api/inbox/:id/attach-canvas — canvas pairing (slice 3), container half. ADR-0018 /
    // #264: the edge already did the row work — picked the canvas (same-workspace only) or
    // created one in the Conversation's workspace, and wrote the Conversation→canvas edge — and
    // forwards the result on x-inbox-canvas-pairing. All that is left here is the part that
    // genuinely needs the container: mutating the live canvas session to place the chat card.
    const attachRoute = /^\/api\/inbox\/([^/]+)\/attach-canvas$/.exec(path);
    if (attachRoute && req.method === 'POST') {
      const id = decodeURIComponent(attachRoute[1] as string);
      // Parsed, never trusted — an absent, malformed, or mismatched payload is a 404, exactly as
      // an unresolvable Conversation was before the split.
      const pairing = decodeForwardedPairing(req.headers.get(INBOX_PAIRING_HEADER));
      if (!pairing || pairing.id !== id) return json({ error: 'not_found' }, 404);
      // The card goes into the ROOM (#305), like every other canvas write: one store per
      // request, flushed before the 200. `placeChatCard` may touch more than one canvas
      // (it moves a card off its old one), so each opened store is flushed.
      const opened = new Map<string, RemoteCanvasStore>();
      try {
        await placeChatCard(
          {
            getSession: async (cid) => {
              let store = opened.get(cid);
              if (!store) {
                store = await openCanvasRoom(cid);
                opened.set(cid, store);
              }
              return {
                shapes: () => store!.getState().shapes,
                upsert: (shapes) => void store!.upsert(shapes as never),
              };
            },
            chatIdForSession: (sid: string) => chatIdForSession(sid) ?? null,
          },
          pairing,
        );
        for (const store of opened.values()) await store.flush();
      } catch (e) {
        return json({ error: `chat card placement failed: ${(e as Error).message}` }, 502);
      }
      return json({ ok: true, canvasId: pairing.canvasId });
    }

    // (POST /api/inbox/:id/reply is gone. It was retired by ADR-0009 / #124 — a reply is a
    // chat SEND through the edge proxy now (worker/inbox-bridge.ts flips waiting_on there) —
    // and it was the last route on this bridge that read a Conversation from a database.
    // ADR-0018 / #266 removed that database, and with it the unreachable route.)

    // #297: the shape count went with the in-process store. Liveness is what this answers.
    if (path === '/api/health') return json({ ok: true });

    // Avatar-capture handoff: persist a recorded clip to disk so the next pipeline
    // step can read it. Browser sends FormData { file, session, shot, mime, duration }.
    if (path === '/api/capture/save' && req.method === 'POST') {
      const form = await req.formData();
      const file = form.get('file');
      const session = String(form.get('session') ?? '');
      const shot = String(form.get('shot') ?? '');
      const mime = String(form.get('mime') ?? 'video/webm');
      const duration = Number(form.get('duration') ?? 0);
      if (!(file instanceof Blob) || !session || !shot)
        return json({ error: 'file, session, shot required' }, 400);
      const res = await saveCapture(session, shot, mime, duration, await file.arrayBuffer());
      return json({ ok: true, ...res });
    }
    if (path === '/api/capture/list' && req.method === 'GET') {
      const session = url.searchParams.get('session') ?? '';
      if (!session) return json({ error: 'session required' }, 400);
      return json({ root: CAPTURE_ROOT, clips: await listCaptures(session) });
    }

    // Mint a LiveAvatar (HeyGen) session token from our server-held API key, so the
    // key never touches the browser. Verified against docs.liveavatar.com:
    //   POST https://api.liveavatar.com/v1/sessions/token
    //   header  X-API-KEY: <key>
    //   body    { mode, avatar_id, avatar_persona? }
    //   token   response.data.session_token
    // The avatar is chosen HERE at token mint (the SDK constructor takes only the
    // token), so an avatar_id is required. We mint in FULL mode: LITE mode has no
    // text-to-speech at all (the SDK throws "Not permitted in LITE mode" for
    // repeat()/message() — LITE only lip-syncs to audio you supply via repeatAudio),
    // so FULL is required for the avatar to speak typed text (and later, voice/mic).
    // avatar_persona fields are all optional, BUT without a context_id the avatar is
    // in "restricted mode" — it speaks typed text back verbatim and never replies to
    // speech. A context (system prompt + default LLM, created via POST /v1/contexts)
    // is what makes it converse, so LIVE_AVATAR_CONTEXT_ID drives the conversational
    // brain for both text and mic. FULL is ~$0.20/min vs LITE ~$0.10/min. NOTE: a
    // LiveAvatar key is NOT a HeyGen key — get both from app.liveavatar.com/developers.
    if (path === '/api/live-avatar-token' && req.method === 'GET') {
      const key = process.env.LIVE_AVATAR_KEY;
      const avatarId = process.env.LIVE_AVATAR_ID;
      const contextId = process.env.LIVE_AVATAR_CONTEXT_ID;
      if (!key) return json({ error: 'LIVE_AVATAR_KEY not set (LiveAvatar API key from app.liveavatar.com/developers, not a HeyGen key)' }, 503);
      if (!avatarId) return json({ error: 'LIVE_AVATAR_ID not set (a LiveAvatar avatar_id UUID — the token is minted for one avatar)' }, 503);
      const persona: Record<string, unknown> = { language: 'en' };
      if (contextId) persona.context_id = contextId; // omit -> restricted mode (no replies)
      const res = await fetch('https://api.liveavatar.com/v1/sessions/token', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'FULL', avatar_id: avatarId, avatar_persona: persona }),
      });
      const data = (await res.json().catch(() => null)) as { data?: { session_token?: string } } | null;
      if (!res.ok) return json({ error: `LiveAvatar token exchange failed: ${res.status}`, detail: data }, 502);
      const token = data?.data?.session_token;
      if (!token) return json({ error: 'No data.session_token in LiveAvatar response', detail: data }, 502);
      return json({ token });
    }

    return json({ error: `not found: ${path}` }, 404);
}

// Bind the port only when run as the entrypoint (production / dev, always launched
// as `bun run server/bridge.ts`). Importing the module (tests) gets handleRequest +
// the chat hub without starting a listener.
if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 0, // SSE streams must not be reaped
    maxRequestBodySize: 2 * 1024 * 1024 * 1024, // 2GB: avatar-capture clips can be large
    fetch: handleRequest,
  });
  console.log(`[bridge] canvas + agent on http://localhost:${server.port}`);
}
