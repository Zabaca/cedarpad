// The bridge: a single Bun process that owns the canvas store, syncs it to the
// browser over SSE, and runs the agent. Browser draws -> POST -> store; agent
// draws -> tool -> same store -> SSE -> browser. One source of truth.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { buildApp } from './notebook/index.ts';
import { makeDb } from '../lib/db/index.ts';

import type { CanvasState } from '../src/shapes.ts';
import { createStore } from '../src/store.ts';
import { normalizeIncomingShape, normalizePage, primeIdCounter } from '../src/normalize.ts';
import { BlobStore, selectBackend } from './blob-store.ts';
import { CanvasPersistence } from './canvas-persistence.ts';
import { ChatMetaStore } from './chat-meta.ts';
import { PersistSink } from './persistable.ts';
import { maxMtimeMs, tarSubtree } from './overlay.ts';
import { loadSessionTranscript } from './session-transcript.ts';
import { type CanvasImage, type ChatEvent, runChat } from './agent.ts';
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

// --- notebook mount ----------------------------------------------------------
// Notebook (the Problem/Solution intelligence app) lives in this package:
// server/notebook (API), src/notebook (UI), lib (shared). Its Hono app (/v1 +
// Better Auth /api/auth) runs IN this bun process, so the whole repo deploys as
// one Cloudflare instance. Its env comes from .dev.vars in dev and from real
// process.env in the container. Better Auth is origin-sensitive, so we point
// baseURL + trustedOrigins at the serving origin; real env wins in the container.
const NOTEBOOK_ORIGIN = process.env.NOTEBOOK_ORIGIN ?? 'http://localhost:4510';

function loadNotebookEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m?.[1]) vars[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .dev.vars (container/prod): the container supplies these as real env.
  }
  const env = { ...vars, ...process.env } as Record<string, string>;
  if (!process.env.BETTER_AUTH_URL) env.BETTER_AUTH_URL = NOTEBOOK_ORIGIN;
  if (!process.env.WEB_ORIGIN) env.WEB_ORIGIN = NOTEBOOK_ORIGIN;
  return env;
}

const notebookEnv = loadNotebookEnv();

// DB: local dev uses a libSQL FILE (no turso daemon needed); the container/prod
// uses the real remote Turso from its env. `@libsql/client` (node) speaks both, so
// the bridge builds ONE db and injects it into the notebook app. Local migrations
// run on boot (idempotent); remote Turso is migrated by the deploy, so we don't
// auto-migrate it here.
const notebookRemoteTurso =
  !!notebookEnv.TURSO_URL && !/(^file:|127\.0\.0\.1|localhost)/.test(notebookEnv.TURSO_URL);
const notebookDbUrl = notebookRemoteTurso
  ? notebookEnv.TURSO_URL!
  : `file:${fileURLToPath(new URL('../.notebook-dev.db', import.meta.url))}`;
const notebookClient = createClient(
  notebookRemoteTurso && notebookEnv.TURSO_KEY
    ? { url: notebookDbUrl, authToken: notebookEnv.TURSO_KEY }
    : { url: notebookDbUrl },
);
if (!notebookRemoteTurso) {
  await migrate(drizzle(notebookClient), {
    migrationsFolder: fileURLToPath(new URL('../lib/db/migrations', import.meta.url)),
  });
}
const notebookApp = buildApp({ db: makeDb(notebookClient) });

// SSE subscribers for live canvas state.
const canvasClients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
const sse = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);

// Canvas persistence: local disk in dev, R2 in the container (selected by env).
// One workspace, one canvas for v1. Load is async, so the store is constructed
// after the boot read; the data-loss guard refuses to overwrite a saved canvas
// with empty if that read failed (story 30).
const WORKSPACE = process.env.CANVAS_WORKSPACE ?? 'default';
const CANVAS_ID = process.env.CANVAS_ID ?? 'default';
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
const blobStore = new BlobStore(selectBackend(`${PKG_ROOT}.persist`));
const persist = new CanvasPersistence(blobStore, WORKSPACE, CANVAS_ID);

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

let restored: CanvasState | null = null;
try {
  restored = await persist.load();
} catch (err) {
  // Visible error (story 29): start degraded rather than silently handing back an
  // empty canvas. The guard then blocks an empty-over-known-good save.
  console.error('[persist] canvas-state load failed; starting in degraded mode:', err);
}
const seedShapes = restored?.shapes ?? [];
primeIdCounter(seedShapes.map((s) => s.id));

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Persistence health, surfaced at /api/status and logged on every flush. The whole
// point: a save that silently never fires (the bug that hid for an hour) is now
// visible — `pending` true with a growing live-vs-saved gap means edits aren't
// reaching R2.
const saveHealth = {
  bootAt: Date.now(),
  liveVersion: restored?.version ?? 0,
  savedVersion: restored ? (restored.version ?? 0) : -1, // best guess at what R2 holds
  lastAttemptAt: 0,
  lastOkAt: 0,
  lastResult: 'none' as 'none' | 'ok' | 'skipped' | 'failed' | 'blocked',
  lastError: null as string | null,
  blockedShrink: null as { from: number; to: number } | null,
  pending: false,
};
const store = createStore(
  seedShapes,
  (state) => {
    // Save is TRIGGERED here on every real store mutation (version advanced),
    // debounced 1s so rapid edits coalesce into one R2 write.
    saveHealth.liveVersion = state.version;
    saveHealth.pending = true;
    console.log(`[persist] change → v${state.version} (${state.shapes.length} shapes, ${state.pages.length} pages); flush scheduled`);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const v = state.version;
      saveHealth.lastAttemptAt = Date.now();
      console.log(`[persist] flushing v${v} → ${process.env.R2_BUCKET ? 'R2' : 'fs'}…`);
      persist
        .save(state)
        .then(async (wrote) => {
          saveHealth.pending = false;
          if (wrote) {
            saveHealth.lastResult = 'ok';
            saveHealth.savedVersion = v;
            saveHealth.lastOkAt = Date.now();
            saveHealth.blockedShrink = null;
            console.log(`[persist] flush OK v${v}`);
          } else if (persist.blockedShrink) {
            // The destructive-shrink guard refused to overwrite a substantial canvas with a
            // near-empty one (a tldraw-crash nuke). The disk still holds the good state, so
            // reseed the LIVE store from it: the upsert's onChange re-broadcasts the restored
            // canvas to every browser and re-persists it, so the session self-heals with no
            // reload or restart. (A genuine full clear is also caught — delete in chunks or
            // restart to intentionally empty a large canvas.)
            const { from, to } = persist.blockedShrink;
            saveHealth.lastResult = 'blocked';
            saveHealth.blockedShrink = persist.blockedShrink;
            console.warn(`[persist] BLOCKED catastrophic shrink v${v}: ${from} → ${to} shapes (kept ${Math.round((100 * to) / from)}%). Disk preserved; reseeding live store from disk.`);
            try {
              const good = await persist.load();
              if (good) {
                store.upsertPages(good.pages);
                store.upsert(good.shapes);
              }
            } catch (err) {
              console.error('[persist] reseed-from-disk failed; restart the bridge to recover the canvas:', err);
            }
          } else {
            saveHealth.lastResult = 'skipped';
            console.log(`[persist] flush SKIPPED v${v} (degraded + empty)`);
          }
        })
        .catch((err) => {
          saveHealth.pending = false;
          saveHealth.lastResult = 'failed';
          saveHealth.lastError = String((err as Error)?.message ?? err);
          console.error(`[persist] flush FAILED v${v}:`, err);
        });
    }, 1000);
    for (const c of canvasClients) {
      try {
        c.enqueue(sse(state));
      } catch {
        canvasClients.delete(c);
      }
    }
  },
  restored?.pages ?? [],
);

// Screenshot round-trip: the agent's view_canvas tool asks the browser (over SSE)
// for a PNG of the live canvas; the browser renders via tldraw and POSTs it back,
// correlated by id. Returns null if no browser is connected or it times out.
let shotSeq = 0;
const pendingShots = new Map<string, (url: string | null) => void>();
function requestScreenshot(pageId?: string, timeoutMs = 7000): Promise<string | null> {
  if (canvasClients.size === 0) return Promise.resolve(null);
  const id = `shot${(shotSeq += 1)}`;
  const frame = enc.encode(`event: screenshot\ndata: ${JSON.stringify({ id, pageId })}\n\n`);
  for (const c of canvasClients) {
    try {
      c.enqueue(frame);
    } catch {
      canvasClients.delete(c);
    }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingShots.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingShots.set(id, (url) => {
      clearTimeout(timer);
      pendingShots.delete(id);
      resolve(url);
    });
  });
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

function canvasStream(): Response {
  let self: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      canvasClients.add(controller);
      controller.enqueue(sse(store.getState())); // prime with current state
    },
    cancel() {
      canvasClients.delete(self);
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
      controller.enqueue(enc.encode(': subscribed\n\n')); // comment frame: opens + flushes the stream
      // Heartbeat: keeps the connection from going idle-dead during a long silent think, and
      // a closed socket (bridge died) trips EventSource.onerror on the client -> "reconnecting".
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch {
          clearInterval(ping);
          chatClients.delete(controller);
        }
      }, 15000);
    },
    cancel() {
      clearInterval(ping);
      chatClients.delete(self);
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
      for await (const ev of runChat(store, message, sessionId, requestScreenshot, images, chatId, model, forkSession, ac, effort)) {
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

    // Notebook mounted in-process: its data API (/v1/*) and Better Auth (/api/auth/*)
    // are served by the notebook Hono app. This MUST precede the canvas's own /api/*
    // routes below, since /api/auth/* lives under the same /api namespace.
    if (path.startsWith('/v1/') || path === '/v1' || path.startsWith('/api/auth/')) {
      return notebookApp.fetch(req, notebookEnv as never);
    }

    // --- canvas sync ---
    if (path === '/api/canvas' && req.method === 'GET') {
      return json(store.getState() satisfies CanvasState);
    }
    // Persistence health in one read: is the backend R2 or fs, are we degraded, and
    // is what's in memory actually reaching R2? `unsavedVersions` > 0 and rising =
    // edits aren't being persisted (the exact failure that was invisible before).
    if (path === '/api/status' && req.method === 'GET') {
      const s = store.getState();
      const savedV = saveHealth.savedVersion < 0 ? 0 : saveHealth.savedVersion;
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
        clients: canvasClients.size,
        uptimeMs: Date.now() - saveHealth.bootAt,
        at: Date.now(),
      });
    }
    if (path === '/api/canvas/stream' && req.method === 'GET') {
      return canvasStream();
    }
    if (path === '/api/canvas/shapes' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = Array.isArray(body.shapes) ? body.shapes : [];
      try {
        const shapes = raw.map((s) => normalizeIncomingShape(s as Record<string, unknown>));
        const version = store.upsert(shapes);
        return json({ version, count: shapes.length });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path === '/api/canvas/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      return json({ version: store.remove(ids) });
    }
    if (path === '/api/canvas/pages' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = Array.isArray(body.pages) ? body.pages : [];
      try {
        const pages = raw.map((p) => normalizePage(p as Record<string, unknown>));
        return json({ version: store.upsertPages(pages), count: pages.length });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path === '/api/canvas/pages/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      return json({ version: store.removePages(ids) });
    }
    if (path === '/api/canvas/clear' && req.method === 'POST') {
      return json({ version: store.clear() });
    }
    if (path === '/api/canvas/screenshot' && req.method === 'POST') {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const url = typeof body.url === 'string' ? body.url : null;
      pendingShots.get(id)?.(url);
      return json({ ok: true });
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

    if (path === '/api/health') return json({ ok: true, shapes: store.getState().shapes.length });

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
