// The bridge: a single Bun process that owns the canvas store, syncs it to the
// browser over SSE, and runs the agent. Browser draws -> POST -> store; agent
// draws -> tool -> same store -> SSE -> browser. One source of truth.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { buildApp } from '../web-poc/worker/index.ts';
import { conversations, makeDb } from '../web-poc/lib/db/index.ts';

import type { CanvasState } from '../src/shapes.ts';
import { normalizeIncomingShape, normalizePage } from '../src/normalize.ts';
import { bumpAllComponents, bumpSharedModule, nextComponentRev } from '../src/canvas-ops.ts';
import { BlobStore, selectBackend } from './blob-store.ts';
import { type CanvasSession, createCanvasSession, createSessionRegistry } from './canvas-sessions.ts';
import { ChatMetaStore } from './chat-meta.ts';
import { PersistSink } from './persistable.ts';
import { maxMtimeMs, tarSubtree } from './overlay.ts';
import { loadSessionTranscript } from './session-transcript.ts';
import { type Notify, resumeConversation } from './inbox.ts';
import { DEFAULT_REPO, branchName, createRepoWorktreeManager } from './repo-worktree.ts';
import { isDevAgentConversation, runDevAgentApproval } from './dev-agent-workflow.ts';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { backup as backupTranscript } from './transcript-r2.ts';
import { type CanvasImage, type ChatEvent, runChat } from './agent.ts';
import { adoptSharedComponent, promoteComponent } from './components.ts';
import type { ChatFrame } from '../shared/chat-wire.ts';
import { CAPTURE_ROOT, listCaptures, saveCapture } from './capture.ts';

// Build stamp: scripts/deploy.sh writes the git SHA to build-rev.txt right before
// the image build, so /api/status reports exactly which commit is serving. The
// deploy then polls until that matches — turning "is the new code live?" from a
// guess into a deterministic check. "dev" locally (file absent).
const BUILD_REV =
  (await Bun.file(fileURLToPath(new URL('./build-rev.txt', import.meta.url)))
    .text()
    .catch(() => '')).trim() || 'dev';

const PORT = Number(process.env.CANVAS_BRIDGE_PORT ?? 4511);

// --- web-poc mount ---------------------------------------------------------
// web-poc lives in-tree at ./web-poc (imported by relative path, not a workspace
// package). Its Hono app (/v1 + Better Auth /api/auth) runs IN this bun process,
// so the whole repo deploys as one Cloudflare instance. Its env comes from
// web-poc/.dev.vars in dev and from real process.env in the container. Better Auth is
// origin-sensitive, so we point baseURL + trustedOrigins at the canvas serving
// origin (both apps share one origin once mounted); real env wins in the container.
const WEBPOC_ORIGIN = process.env.WEBPOC_ORIGIN ?? 'http://localhost:4510';

function loadWebPocEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const text = readFileSync(new URL('../web-poc/.dev.vars', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m?.[1]) vars[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .dev.vars (container/prod): the container supplies these as real env.
  }
  const env = { ...vars, ...process.env } as Record<string, string>;
  if (!process.env.BETTER_AUTH_URL) env.BETTER_AUTH_URL = WEBPOC_ORIGIN;
  if (!process.env.WEB_ORIGIN) env.WEB_ORIGIN = WEBPOC_ORIGIN;
  return env;
}

const webPocEnv = loadWebPocEnv();

// DB: local dev uses a libSQL FILE (no turso daemon needed); the container/prod
// uses the real remote Turso from its env. `@libsql/client` (node) speaks both, so
// the bridge builds ONE db and injects it into web-poc's app (buildApp then bypasses
// its workerd `@libsql/client/web` path). Local migrations run on boot (idempotent);
// remote Turso is migrated by the deploy, so we don't auto-migrate it here.
const webPocRemoteTurso =
  !!webPocEnv.TURSO_URL && !/(^file:|127\.0\.0\.1|localhost)/.test(webPocEnv.TURSO_URL);
// Worktree-safe: with-worktree-db.sh sets CANVAS_DEV_DB to a per-worktree file:
// URL so parallel worktrees don't share one dev DB. Unset falls back to the
// canonical .web-poc-dev.db, so a plain `bun run dev` is unchanged.
const webPocDbUrl = webPocRemoteTurso
  ? webPocEnv.TURSO_URL!
  : (process.env.CANVAS_DEV_DB ??
    `file:${fileURLToPath(new URL('../.web-poc-dev.db', import.meta.url))}`);
const webPocClient = createClient(
  webPocRemoteTurso && webPocEnv.TURSO_KEY
    ? { url: webPocDbUrl, authToken: webPocEnv.TURSO_KEY }
    : { url: webPocDbUrl },
);
if (!webPocRemoteTurso) {
  await migrate(drizzle(webPocClient), {
    migrationsFolder: fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url)),
  });
}
const webPocDb = makeDb(webPocClient);
const webPocApp = buildApp({ db: webPocDb });

// Inbox (#61): the promote protocol runs against the same web-poc Turso db. The bridge is a
// single-user localhost surface, so the inbox owner + platform workspace come from env (the
// authenticated-user wiring is a platform/#62 concern). notify is a best-effort stub this slice.
const INBOX_USER = process.env.CANVAS_USER ?? 'default';
const notify: Notify = (conv, question) =>
  console.log(`[inbox] waiting_on:human conv=${conv.id} session=${conv.sessionId} q=${question.slice(0, 80)}`);

// SSE encoder shared by the chat multiplexer (canvas SSE lives per-session now).
const enc = new TextEncoder();
const sse = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);

// Canvas persistence: local disk in dev, R2 in the container (selected by env).
// A workspace hosts N canvases (ADR-0007); each canvas is a CanvasSession keyed by
// canvasId in the registry below. Sessions are built lazily on first access; the
// data-loss guard refuses to overwrite a saved canvas with empty if its read failed.
const WORKSPACE = process.env.CANVAS_WORKSPACE ?? 'default';
const DEFAULT_CANVAS_ID = process.env.CANVAS_ID ?? 'default';
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
// Capture the raw backend too: the Inbox transcript backup/restore (#60/#61) keys blobs by
// sessionId (transcript-r2), so it needs the low-level get/put seam, not BlobStore's canvas API.
const blobBackend = selectBackend(`${PKG_ROOT}.persist`);
const blobStore = new BlobStore(blobBackend);

// Per-canvas sessions, keyed by canvasId. The default canvas runs the exact same
// factory as every other, so its single-store behavior is unchanged (it is just the
// first registry entry). The browser selects a canvas via the `x-canvas-id` header
// (or `?canvas=`); absent → the default, so today's un-namespaced /api/canvas/* calls
// resolve to the default canvas exactly as before.
const canvasSessions = createSessionRegistry((id) => createCanvasSession(blobStore, WORKSPACE, id));
function canvasIdFrom(req: Request, url: URL): string {
  return req.headers.get('x-canvas-id') ?? url.searchParams.get('canvas') ?? DEFAULT_CANVAS_ID;
}
// Build the default session at boot so it restores from R2 before the first request —
// preserving today's boot-time load. Chats (multiplexed, not yet per-canvas) run
// against the default canvas's store, as they always have.
const defaultSession: CanvasSession = await canvasSessions.get(DEFAULT_CANVAS_ID);

// Cross-canvas rev-bump for a shared-library change (#55): fan a promote / shared-edit out
// to every already-built canvas that placed the module, so each open canvas re-imports the
// one shared source. The pure target computation + per-store bump live in canvas-ops.
const bumpSharedModuleAcrossCanvases = (module: string): number => bumpSharedModule(canvasSessions.built(), module);

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

// The three file-tar artifacts that the dead fs.watch left silent (ADR 0003). Each registers
// as a Persistable through one sink so all three report health at /api/status; saved at
// turn-completion (sessions always; components/custom on a max-mtime dirty-check). Canvas keeps
// its own onChange trigger + health below. R2 in the container only — locally these files
// already live on disk and the session JSONL is read in place.
const COMPONENTS_DIR = `${PKG_ROOT}src/canvas-components`;
const CUSTOM_DIR = `${PKG_ROOT}server/custom`;
const SESSIONS_DIR = `${process.env.HOME ?? '/root'}/.claude/projects`;
const sink = new PersistSink();
sink.register({ name: 'sessions', serialize: () => tarSubtree(SESSIONS_DIR), save: (b) => blobStore.saveSessions(WORKSPACE, b as Uint8Array) });
sink.register({ name: 'components', serialize: () => tarSubtree(COMPONENTS_DIR), save: (b) => blobStore.saveComponents(WORKSPACE, b as Uint8Array) });
sink.register({ name: 'custom', serialize: () => tarSubtree(CUSTOM_DIR), save: (b) => blobStore.saveCustom(WORKSPACE, b as Uint8Array) });

const savedMtime: Record<'components' | 'custom', number> = { components: 0, custom: 0 };
async function flushIfDirty(name: 'components' | 'custom', dir: string): Promise<void> {
  const m = await maxMtimeMs(dir);
  if (m <= savedMtime[name]) return; // a draw-only turn left the library untouched
  savedMtime[name] = m;
  await sink.flush(name);
}

/** ADR 0003 turn-completion batch. chatMeta persists always (dev + prod, for resume +
 *  cross-device rehydrate); the file-tar artifacts persist to R2 in the container only. */
async function onTurnComplete(): Promise<void> {
  await chatMeta.save().catch((err) => console.error('[chatmeta] save failed:', err));
  if (!process.env.R2_BUCKET) return;
  await sink.flush('sessions'); // a turn always wrote JSONL
  await flushIfDirty('components', COMPONENTS_DIR);
  await flushIfDirty('custom', CUSTOM_DIR);
}

// The per-canvas store, persistence, save-health, SSE subscriber set, and screenshot
// round-trip now live in CanvasSession (server/canvas-sessions.ts). `defaultSession`
// (built at boot above) is the default canvas; the chat path uses it, exactly as the
// single global store did before.

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

function canvasStream(session: CanvasSession): Response {
  const clients = session.clients;
  let self: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      clients.add(controller);
      markAlive();
      ensureReaper();
      controller.enqueue(sse(session.store.getState())); // prime with current state
    },
    cancel() {
      clients.delete(self);
      console.log(`[clients] canvas ${session.canvasId} stream cancel -> canvas=${clients.size} chat=${chatClients.size}`);
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

// All chat sessions multiplex over ONE SSE stream per client. A turn's events are
// broadcast to every subscriber, each frame TAGGED with its chatId so the client
// routes it to the right session. This is deliberately one stream for ALL chats
// (not one per chat): a browser caps ~6 concurrent connections per host over
// HTTP/1.1, and each EventSource holds one open forever, so one-per-chat-card means
// a single tab with ~5 chats + the canvas stream saturates the cap and starves
// every POST (send/shapes) into "pending". One shared stream keeps it flat at 2.
export const chatClients = new Set<ReadableStreamDefaultController>();

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
    // cold-boots and restores from R2. Flush canvas state first so nothing is lost
    // (idle already means no in-flight edits, but be safe), with a hard bail so a
    // stuck write can't keep us alive.
    if (reaper) {
      clearInterval(reaper);
      reaper = null;
    }
    // Only self-exit inside the CF container (where it maps to container sleep). In
    // local dev there is nothing to sleep, so never kill the developer's dev server.
    if (!process.env.IS_SANDBOX) return;
    console.log(`[idle] no client heartbeat for ${STALE_MS}ms -> flush + exit so the container can sleep`);
    const bail = setTimeout(() => process.exit(0), 3000);
    // Flush every canvas session built this run (not just the default) so no canvas
    // loses in-flight edits when the container sleeps.
    void Promise.allSettled(
      canvasSessions.resolved().map((p) => p.then((s) => s.persist.save(s.store.getState()))),
    )
      .catch(() => {})
      .finally(() => {
        clearTimeout(bail);
        process.exit(0);
      });
  }, 10_000);
}

function broadcastChat(chatId: string, ev: ChatEvent): void {
  // Build the on-wire frame through the shared type, so a new ChatEvent kind added
  // in only one place fails the build here until the frame shape accounts for it.
  const frame = sse({ chatId, ...ev } satisfies ChatFrame);
  for (const c of chatClients) {
    try {
      c.enqueue(frame);
    } catch {
      chatClients.delete(c);
    }
  }
}

/** Subscribe to ALL chats' events (SSE), one stream per client. Subscribe BEFORE sending. */
function chatStream(): Response {
  let self: ReadableStreamDefaultController;
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      chatClients.add(controller);
      markAlive();
      ensureReaper();
      controller.enqueue(enc.encode(': subscribed\n\n')); // comment frame: opens + flushes the stream
      // Heartbeat: keeps the connection from going idle-dead during a long silent think, and
      // a closed socket (bridge died) trips EventSource.onerror on the client -> "reconnecting".
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch {
          clearInterval(ping);
          chatClients.delete(controller);
          console.log(`[clients] chat ping dead-controller -> chat=${chatClients.size} canvas(default)=${defaultSession.clients.size}`);
        }
      }, 15000);
    },
    cancel() {
      clearInterval(ping);
      chatClients.delete(self);
      console.log(`[clients] chat stream cancel -> chat=${chatClients.size} canvas(default)=${defaultSession.clients.size}`);
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

// Live turns, keyed by chatId, so POST /interrupt can abort the in-flight query
// (Esc / Stop in the UI). One turn per chat at a time, so one aborter per chat.
const aborters = new Map<string, AbortController>();

/** Run one turn for a chat and broadcast its events. Fire-and-forget (output is the SSE). */
function runChatTurn(chatId: string, message: string, sessionId: string | null, images: CanvasImage[], model?: string, forkSession?: boolean, effort?: string): void {
  const ac = new AbortController();
  aborters.set(chatId, ac);
  void (async () => {
    let finalSessionId = sessionId;
    try {
      const inbox = { db: webPocDb, userId: INBOX_USER, workspaceId: WORKSPACE, notify };
      for await (const ev of runChat(defaultSession.store, message, sessionId, defaultSession.requestScreenshot, images, chatId, model, forkSession, ac, effort, defaultSession.canvasId, bumpSharedModuleAcrossCanvases, inbox)) {
        if (ev.kind === 'done' && ev.sessionId) finalSessionId = ev.sessionId;
        broadcastChat(chatId, ev satisfies ChatEvent);
      }
    } catch (e) {
      broadcastChat(chatId, { kind: 'done', sessionId, costUsd: 0, error: (e as Error).message } satisfies ChatEvent);
    } finally {
      aborters.delete(chatId);
      // ADR 0004: stamp the (possibly new/forked) sessionId so resume + rehydrate find the JSONL.
      if (finalSessionId && finalSessionId !== sessionId) chatMeta.set(chatId, { sessionId: finalSessionId });
      // ADR 0003: persist sessions/components/custom now that the turn settled.
      await onTurnComplete();
      // Inbox (#60/#61): mirror THIS session's transcript to R2 keyed by sessionId, so the Inbox
      // can render history and resume can restore it while the runner sleeps. Best-effort.
      if (finalSessionId) {
        await backupTranscript(blobBackend, SESSIONS_DIR, finalSessionId).catch((err) =>
          console.error('[inbox] transcript backup failed:', err),
        );
      }
    }
  })();
}

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

    // web-poc mounted in-process: its data API (/v1/*) and Better Auth (/api/auth/*)
    // are served by web-poc's Hono app. This MUST precede the canvas's own /api/*
    // routes below, since /api/auth/* lives under the same /api namespace.
    if (path.startsWith('/v1/') || path === '/v1' || path.startsWith('/api/auth/')) {
      return webPocApp.fetch(req, webPocEnv as never);
    }

    // --- canvas sync ---
    // Every canvas route resolves its CanvasSession from the request's canvasId
    // (x-canvas-id header / ?canvas=, default 'default'), so N canvases share one
    // bridge with per-canvas stores. Un-namespaced calls resolve to the default
    // canvas, so today's single-canvas frontend is unchanged.
    if (path === '/api/canvas' && req.method === 'GET') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      return json(session.store.getState() satisfies CanvasState);
    }
    // Persistence health in one read: is the backend R2 or fs, are we degraded, and
    // is what's in memory actually reaching R2? `unsavedVersions` > 0 and rising =
    // edits aren't being persisted (the exact failure that was invisible before).
    if (path === '/api/status' && req.method === 'GET') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const { store, persist, saveHealth } = session;
      const s = store.getState();
      const savedV = saveHealth.savedVersion < 0 ? 0 : saveHealth.savedVersion;
      const canvasClients = session.clients;
      return json({
        buildRev: BUILD_REV,
        backend: process.env.R2_BUCKET ? 'r2' : 'fs',
        bucket: process.env.R2_BUCKET ?? null,
        degraded: persist.isDegraded,
        live: { version: s.version, shapes: s.shapes.length, pages: s.pages.length },
        save: saveHealth,
        // ADR 0003: the three turn-completion artifacts (sessions/components/custom) now
        // report health too, so a silent save failure is visible for all four.
        artifacts: sink.healthSnapshot(),
        unsavedVersions: Math.max(0, saveHealth.liveVersion - savedV),
        // Split client counts: chatClients is the warmth driver (its 15s ping pins the
        // container), canvasClients is pingless. Both must reach 0 for the container to
        // idle-sleep. chatClients self-cleans (ping enqueue throws on a dead controller);
        // canvasClients only shrinks on cancel() or the next broadcast, so it can lag.
        clients: canvasClients.size,
        chatClients: chatClients.size,
        canvasClients: canvasClients.size,
        uptimeMs: Date.now() - saveHealth.bootAt,
        at: Date.now(),
      });
    }
    if (path === '/api/canvas/stream' && req.method === 'GET') {
      return canvasStream(await canvasSessions.get(canvasIdFrom(req, url)));
    }
    if (path === '/api/canvas/shapes' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const body = await readBody(req);
      const raw = Array.isArray(body.shapes) ? body.shapes : [];
      try {
        const shapes = raw.map((s) => normalizeIncomingShape(s as Record<string, unknown>));
        const version = session.store.upsert(shapes);
        return json({ version, count: shapes.length });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path === '/api/canvas/delete' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      return json({ version: session.store.remove(ids) });
    }
    if (path === '/api/canvas/pages' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const body = await readBody(req);
      const raw = Array.isArray(body.pages) ? body.pages : [];
      try {
        const pages = raw.map((p) => normalizePage(p as Record<string, unknown>));
        return json({ version: session.store.upsertPages(pages), count: pages.length });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path === '/api/canvas/pages/delete' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      return json({ version: session.store.removePages(ids) });
    }
    if (path === '/api/canvas/clear' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      return json({ version: session.store.clear() });
    }
    if (path === '/api/canvas/screenshot' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const screenurl = typeof body.url === 'string' ? body.url : null;
      session.resolveScreenshot(id, screenurl);
      return json({ ok: true });
    }

    // --- shared component library (#55): the UI action for promote / adopt. Mirrors the
    // agent tools; each resolves the caller's canvas from the same x-canvas-id selection. ---
    if (path === '/api/components/promote' && req.method === 'POST') {
      const canvasId = canvasIdFrom(req, url);
      const body = await readBody(req);
      const module = typeof body.module === 'string' ? body.module : '';
      try {
        promoteComponent(canvasId, module);
        return json({ ok: true, reloaded: bumpSharedModuleAcrossCanvases(module) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path === '/api/components/adopt' && req.method === 'POST') {
      const session = await canvasSessions.get(canvasIdFrom(req, url));
      const body = await readBody(req);
      const module = typeof body.module === 'string' ? body.module : '';
      try {
        adoptSharedComponent(session.canvasId, module);
        return json({ ok: true, reloaded: bumpAllComponents(session.store, nextComponentRev(session.store)) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // --- agent chat (multiplexed pub/sub) ---
    // GET  /api/chat/stream    — subscribe to ALL chats' events (one SSE per client)
    // POST /api/chat/:id/send  — run a turn in a chat; events broadcast (tagged) to subscribers
    if (path === '/api/chat/stream' && req.method === 'GET') {
      return chatStream();
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
      if (chatClients.size === 0) return json({ error: 'no_subscribers', chatId }, 425);
      const body = await readBody(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      // Pasted screenshots: [{ media_type, data(base64) }]. Allow an image-only turn.
      const rawImages = Array.isArray(body.images) ? body.images : [];
      const images: CanvasImage[] = rawImages
        .filter((im): im is CanvasImage => !!im && typeof im.media_type === 'string' && typeof im.data === 'string')
        .map((im) => ({ media_type: im.media_type, data: im.data }));
      if (!message && images.length === 0) return json({ error: 'message or image required' }, 400);
      // ADR 0004: sessionId/model/effort/fork are server-owned (ChatMeta), not in the body.
      const meta = chatMeta.get(chatId);
      const forkSession = chatMeta.consumeFork(chatId); // one-shot; cleared in memory now
      if (forkSession) void chatMeta.save().catch((err) => console.error('[chatmeta] save failed:', err)); // persist the clear so a recycle can't re-fork
      const effort = meta.effort && meta.effort !== 'default' ? meta.effort : undefined; // 'default' = let the model decide
      dispatchChatTurn(chatId, message, meta.sessionId, images, meta.model, forkSession, effort);
      return json({ ok: true }, 202);
    }
    // POST /api/chat/:id/config — update server-owned ChatMeta (model/effort/forkNext),
    // persist it, and broadcast a `config` frame so every open tab converges (ADR 0004).
    const configRoute = /^\/api\/chat\/([^/]+)\/config$/.exec(path);
    if (configRoute && req.method === 'POST') {
      const chatId = decodeURIComponent(configRoute[1] as string);
      const body = await readBody(req);
      const patch: { model?: string; effort?: string; forkNext?: boolean } = {};
      if (typeof body.model === 'string') patch.model = body.model;
      if (typeof body.effort === 'string') patch.effort = body.effort;
      if (typeof body.forkNext === 'boolean') patch.forkNext = body.forkNext;
      chatMeta.set(chatId, patch);
      await chatMeta.save().catch((err) => console.error('[chatmeta] save failed:', err));
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
      await chatMeta.save().catch((err) => console.error('[chatmeta] save failed:', err));
      return json({ ok: true });
    }
    // GET /api/chat/:id/transcript — rehydrate on (re)connect: the JSONL-derived settled
    // transcript + the current config (ADR 0004). Pull-on-connect, per chat; the shared
    // /api/chat/stream carries only live in-flight frames.
    const transcriptRoute = /^\/api\/chat\/([^/]+)\/transcript$/.exec(path);
    if (transcriptRoute && req.method === 'GET') {
      const chatId = decodeURIComponent(transcriptRoute[1] as string);
      const meta = chatMeta.get(chatId);
      const events = meta.sessionId ? await loadSessionTranscript(SESSIONS_DIR, meta.sessionId) : [];
      return json({ config: { model: meta.model, effort: meta.effort, forkNext: meta.forkNext }, events });
    }
    // POST /api/chat/:id/interrupt — abort the in-flight turn (Esc / Stop).
    const interruptRoute = /^\/api\/chat\/([^/]+)\/interrupt$/.exec(path);
    if (interruptRoute && req.method === 'POST') {
      const chatId = decodeURIComponent(interruptRoute[1] as string);
      aborters.get(chatId)?.abort();
      return json({ ok: true });
    }

    // POST /api/inbox/:id/reply — the human answers an ask_human item (#61). Restore the session's
    // transcript from R2, resume the SDK Session with the reply, and flip waiting_on:agent. The
    // Inbox UI (#62) calls this. Auth is deferred to the platform Shell that fronts the bridge
    // (single-user localhost today); resumeConversation itself is runner-agnostic.
    const inboxReplyRoute = /^\/api\/inbox\/([^/]+)\/reply$/.exec(path);
    if (inboxReplyRoute && req.method === 'POST') {
      const id = decodeURIComponent(inboxReplyRoute[1] as string);
      const body = await readBody(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) return json({ error: 'message required' }, 400);
      const conv = await conversations.get(webPocDb, id);
      if (!conv) return json({ error: `conversation not found: ${id}` }, 404);

      // Dev-agent Conversations (#51/#66) resume down the PR path, NOT the canvas chat path:
      // James's reply approves a candidate, so we drive the chosen refactor in a fresh
      // worktree and open a PR (#64) — the durable code artifact. Routed solely by the
      // Conversation's dev-agent workspace tag. Simplification (noted on #66): the refactor
      // runs a fresh SDK turn in the worktree seeded with the thread summary + reply rather
      // than resuming the explore session's JSONL into the worktree cwd; the PR fields are
      // derived from the summary. The PR — not a resumed transcript — is the durable output.
      if (isDevAgentConversation(conv)) {
        const git = createRepoWorktreeManager({
          repo: DEFAULT_REPO,
          workspaceRoot: `${CANVAS_CWD}/.dev-agent/${conv.id}`,
        });
        const url = await runDevAgentApproval(
          {
            git,
            branch: branchName(conv.id, String(Date.now())),
            applyRefactor: async (worktreePath, humanMessage) => {
              const prompt = [
                `Architecture review thread: ${conv.summary ?? '(no summary)'}`,
                '',
                `The human approved with: ${humanMessage}`,
                '',
                'Implement the approved deepening in this worktree. Make the edits only — do not commit or push.',
              ].join('\n');
              for await (const _m of query({
                prompt,
                options: { cwd: worktreePath, permissionMode: 'bypassPermissions', maxTurns: 50 },
              })) {
                // drain the stream; the edits land on disk, which commit() then stages.
              }
              return {
                commitMessage: `refactor: ${conv.summary ?? 'dev-agent deepening'}`,
                pr: {
                  title: conv.summary ?? 'Dev-agent architecture deepening',
                  body: `Approved from the Inbox thread.\n\n> ${humanMessage}`,
                },
              };
            },
          },
          message,
        );
        const flipped = await conversations.reply(webPocDb, conv.id);
        return json({ ok: true, conversation: flipped, pr: url });
      }

      const updated = await resumeConversation(
        {
          db: webPocDb,
          getter: blobBackend,
          projectsDir: SESSIONS_DIR,
          cwd: CANVAS_CWD,
          // Reuse the chat-turn machinery: resume streams + persists + backs up like any turn.
          runTurn: (sessionId, msg) => {
            dispatchChatTurn(chatIdForSession(sessionId) ?? conv.id, msg, sessionId, []);
          },
        },
        conv,
        message,
      );
      return json({ ok: true, conversation: updated });
    }

    if (path === '/api/health') return json({ ok: true, shapes: defaultSession.store.getState().shapes.length });

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

    // Agent-authored backend handlers run in the ISOLATED extension server (ADR
    // 0002), never in this process — so a bad handler can't crash the core/canvas.
    // Proxy /api/custom/* straight through; a 502 just means that server is down
    // (dev.ts is restarting it), which leaves the canvas fully intact.
    if (path.startsWith('/api/custom/')) {
      const target = `http://localhost:${process.env.CUSTOM_PORT ?? 4512}${path}${url.search}`;
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
        return await fetch(target, { method: req.method, headers: req.headers, body });
      } catch {
        return json({ error: 'extension server unreachable' }, 502);
      }
    }

    return json({ error: `not found: ${path}` }, 404);
}

// Bind the port only when run as the entrypoint (production / dev, always launched
// as `bun run server/bridge.ts`). Importing the module (tests) gets handleRequest +
// the chatClients set without starting a listener.
if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 0, // SSE streams must not be reaped
    maxRequestBodySize: 2 * 1024 * 1024 * 1024, // 2GB: avatar-capture clips can be large
    fetch: handleRequest,
  });
  console.log(`[bridge] canvas + agent on http://localhost:${server.port}`);
}
