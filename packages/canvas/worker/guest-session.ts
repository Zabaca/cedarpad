import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/client.ts';
import { getActiveShareLink } from '../web-poc/lib/db/queries/share-links.ts';

// The guest door + its credential (canvas ADR-0015, PRD #220 slice 3).
//
// `/share/<linkId>` validates the capability row and mints a SIGNED, HttpOnly guest-session
// cookie carrying {linkId, canvasId, workspaceId, guestChat}; the sole gate (slice 4) reads
// it alongside the Better Auth cookie and confines the session to the link's canvas. HMAC
// with BETTER_AUTH_SECRET — same trust root as member sessions, no second secret to rotate.
// Guests are NOT `user` rows (they reuse the per-browser guest identity, #211), so this is
// deliberately a parallel cookie, not a Better Auth session.

export const GUEST_COOKIE = 'cs_guest';

// Single contract for the cookie payload (CLAUDE.md §7) — parse at the boundary on read.
export const GuestSessionPayload = z.object({
  linkId: z.string().min(1),
  canvasId: z.string().min(1),
  workspaceId: z.string().min(1),
  guestChat: z.boolean(),
  /** Huddle capability (ADR-0017): the link's guests may join this canvas's voice room.
   * Optional so pre-huddle cookies stay valid. */
  guestHuddle: z.boolean().optional(),
  /** Set = component-scoped link (PRD #221): the guest surface is that one shape,
   * fullscreen, chat fully denied. Optional so pre-#221 cookies stay valid. */
  shapeId: z.string().min(1).optional(),
});
export type GuestSession = z.infer<typeof GuestSessionPayload>;

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

/** `base64url(json).base64url(hmac-sha256(json))` — the cookie value. */
export async function mintGuestCookie(secret: string, payload: GuestSession): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), body);
  return `${b64url(body)}.${b64url(sig)}`;
}

const fromB64url = (s: string): Uint8Array => {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/** The guest session iff the cookie header carries a validly-signed payload; null otherwise. */
export async function readGuestSession(cookieHeader: string | null, secret: string): Promise<GuestSession | null> {
  const raw = cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${GUEST_COOKIE}=`))
    ?.slice(GUEST_COOKIE.length + 1);
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  try {
    const bodyBytes = fromB64url(body);
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), bodyBytes);
    if (!ok) return null;
    const parsed = GuestSessionPayload.safeParse(JSON.parse(new TextDecoder().decode(bodyBytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * GET /share/<linkId>: a live link mints the guest cookie and 302s into the app (the Shell
 * loads in guest mode, slice 5). Revoked and unknown links are the SAME 404 on purpose —
 * the door never confirms a link once existed.
 */
export async function handleShareAccept(
  request: Request,
  db: Database,
  secret: string,
  linkId: string,
): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const link = await getActiveShareLink(db, linkId);
  if (!link) return new Response('link not found', { status: 404 });
  const cookie = await mintGuestCookie(secret, {
    linkId: link.id,
    canvasId: link.canvasId,
    workspaceId: link.workspaceId,
    guestChat: link.guestChat,
    ...(link.guestHuddle ? { guestHuddle: true } : {}),
    ...(link.shapeId ? { shapeId: link.shapeId } : {}),
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': `${GUEST_COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
