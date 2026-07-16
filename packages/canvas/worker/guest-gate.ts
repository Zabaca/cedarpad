import type { GuestSession } from './guest-session.ts';

// The guest confinement boundary (canvas ADR-0015, PRD #220 slice 4). PURE — unit-tested
// off a DB, like decideGate. DEFAULT-DENY: a guest session reaches ONLY what this module
// explicitly allows, scoped to the link's canvas. Every new edge or bridge route is
// guest-denied until deliberately listed here; guest-gate.test.ts is the spec.
//
// Accepted consequence (ADR-0015): allowing the vite module paths exposes the app's
// source to a guest — the pad IS served by the vite dev server, so it cannot boot
// without them. That is a scoped relaxation of PRD #42's pre-auth-disclosure goal:
// post-capability (a member minted the link), never anonymous.

export type GuestGate = { decision: 'allow' } | { decision: 'deny' };

/** What the gate needs to know about the request: path, method, and which canvas the
 * client addressed (`x-canvas-id` header, else `?canvas=` — the bridge's own selection
 * contract). Null when the request names no canvas. */
export interface GuestRequest {
  pathname: string;
  method: string;
  canvas: string | null;
}

/** GET-only vite dev-server surface — the pad's own modules. /shared/ is the pad app's
 * second import root (shared/chat-store.ts etc.) — omitting it 401'd the module graph. */
const VITE_PREFIXES = ['/src/', '/shared/', '/@vite/', '/@fs/', '/@id/', '/node_modules/'];

/** Bridge API ops a guest may use, ALWAYS scoped to the link's canvas via the request's
 * canvas selection. No default-canvas fallback for guests: an unaddressed request is
 * denied outright (the write_component canvas_id lesson — a wrong-canvas write is
 * invisible until something 404s; force the address, surface the mistake). */
const CANVAS_API = new Set([
  'GET /api/canvas',
  'GET /api/canvas/stream',
  'POST /api/canvas/presence',
  'POST /api/canvas/shapes',
  'POST /api/canvas/shapes/create',
  'POST /api/canvas/shapes/update',
  'POST /api/canvas/delete',
  'GET /api/components',
  'POST /api/components/place',
]);

/** Per-module component ops (own-dir read/write + data write for THAT canvas). Promote/
 * adopt are deliberately absent — they mutate the workspace-shared tier. */
const COMPONENT_MODULE = /^\/api\/components\/(?:data\/)?([^/]+)$/;
const COMPONENT_DENY = new Set(['promote', 'adopt', 'place']); // place is in CANVAS_API; promote/adopt denied

export function decideGuestGate(req: GuestRequest, guest: GuestSession): GuestGate {
  const { pathname, method } = req;
  const allow: GuestGate = { decision: 'allow' };
  const deny: GuestGate = { decision: 'deny' };

  // The Shell SPA (guest mode renders from the same bundle) and its static assets.
  if (pathname === '/' || pathname.startsWith('/assets/')) return method === 'GET' ? allow : deny;

  // The guest's own pad — exact canvas + workspace, nothing else.
  if (pathname === `/w/${guest.workspaceId}/canvas/${guest.canvasId}/pad`) return allow;

  // Vite module surface, GET-only.
  if (method === 'GET' && (VITE_PREFIXES.some((p) => pathname.startsWith(p)) || pathname === '/@react-refresh')) {
    return allow;
  }

  // Chat surface (#220 slice 6). The shared SSE stream carries EVERY chat and an
  // EventSource can't stamp headers, so it's allowed path-wise here and confined
  // bridge-side: the edge stamps x-guest-canvas on the proxied request and the bridge
  // delivers only frames of chats bound to that canvas. Transcript reads are view-only
  // for every guest; send/interrupt exist only on links minted with guestChat, and the
  // bridge additionally rejects sends into member conversations (view-only rule).
  // Component-scoped links (PRD #221) share an artifact, not a conversation: the entire
  // chat surface is denied. (Their canvas API + module reuse below is the accepted v1
  // confinement gap — see the ADR-0015 amendment.)
  const componentScoped = !!guest.shapeId;
  if (pathname === '/api/chat/stream' && method === 'GET') return componentScoped ? deny : allow;
  const chatOp = /^\/api\/chat\/[^/]+\/(send|transcript|interrupt)$/.exec(pathname);
  if (chatOp) {
    if (componentScoped) return deny;
    if (chatOp[1] === 'transcript' && method === 'GET') return allow;
    if (guest.guestChat && method === 'POST' && req.canvas === guest.canvasId) return allow;
    return deny;
  }

  // The liveness ping is canvas-AGNOSTIC (the client sends no canvas address) and holds
  // no data — requiring the address here 401'd every guest keepalive.
  if (pathname === '/api/alive' && method === 'POST') return allow;

  // Canvas-addressed bridge ops: the request must explicitly name the link's canvas.
  if (req.canvas !== guest.canvasId) return deny;
  if (CANVAS_API.has(`${method} ${pathname}`)) return allow;
  const mod = COMPONENT_MODULE.exec(pathname);
  if (mod && !COMPONENT_DENY.has(mod[1] as string) && (method === 'GET' || method === 'PUT')) return allow;

  return deny;
}
