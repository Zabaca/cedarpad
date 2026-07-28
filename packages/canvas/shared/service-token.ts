// A bearer a CONTAINER presents to the EDGE, derived from the shared trust root.
//
// Extracted from `shared/platform-rpc.ts` (ADR-0018), which established the pattern:
// `HMAC-SHA256(BETTER_AUTH_SECRET, <label>)`, the same secret the guest cookie is signed
// with, so no new secret enters sops and no deploy gate appears. The LABEL is the key
// separation: a token minted for one surface can never be replayed on another, which is
// why every new container→edge surface takes its own label rather than reusing a token.

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const hmacKey = (secret: string, usages: KeyUsage[]) =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);

export async function serviceToken(secret: string, label: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), new TextEncoder().encode(label));
  return b64url(sig);
}

/** Verify a presented bearer. Goes through `crypto.subtle.verify` rather than comparing
 *  strings, so a wrong token cannot be walked out one character at a time by timing. */
export async function verifyServiceToken(secret: string, label: string, presented: string): Promise<boolean> {
  return verifyMessage(secret, label, presented);
}

async function verifyMessage(secret: string, message: string, presented: string): Promise<boolean> {
  const padded = presented.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(presented.length / 4) * 4, '=');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, new TextEncoder().encode(message));
}

// ---------------------------------------------------------------------------
// The REQUEST-BOUND form (#329)
// ---------------------------------------------------------------------------
//
// `serviceToken` is deterministic: the same string forever, revocable only by rotating
// BETTER_AUTH_SECRET — which logs out every session. That is an acceptable trade for a
// token that never leaves the container↔edge hop, and a bad one for an OPERATOR
// credential, which is handed to a shell or a CI job and travels separately from the
// secret. A static one in a build log is a permanent key to a door whose job is
// overwriting a whole canvas.
//
// So the operator form signs `label | subject | timestamp` and is accepted only inside a
// short window. Two properties: a leaked token expires on its own, and a token minted for
// one subject (a canvas id) cannot be replayed against another.
//
// KNOWN LIMIT, ACCEPTED: replay INSIDE the window is still possible. Closing it needs a
// nonce store, which is not worth a Durable Object round trip on a door used a handful of
// times a year.

/** How far a presented timestamp may sit from the verifier's clock, in EITHER direction.
 *  Deliberately generous: the failure mode this window creates is clock skew between an
 *  operator's laptop and the edge, and a tight window turns ordinary drift into what looks
 *  like an auth bug. Callers surface `reason: 'skew'` verbatim so it doesn't get debugged
 *  as one. */
export const REQUEST_BOUND_WINDOW_MS = 5 * 60_000;

export type RequestBoundResult = { ok: true } | { ok: false; reason: 'malformed' | 'skew' | 'signature' };

/** The signed message. `|` cannot appear in a label or a canvas id, so no two distinct
 *  (label, subject, ts) triples share a message. */
const boundMessage = (label: string, subject: string, ts: number) => `${label}|${subject}|${ts}`;

/**
 * Mint `<timestamp>.<sig>` for one label and one subject. `now` is injectable for tests
 * only — production always uses the caller's clock.
 */
export async function requestBoundToken(
  secret: string,
  label: string,
  subject: string,
  now: number = Date.now(),
): Promise<string> {
  const ts = Math.floor(now);
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, ['sign']),
    new TextEncoder().encode(boundMessage(label, subject, ts)),
  );
  return `${ts}.${b64url(sig)}`;
}

/** Verify a presented operator token. The timestamp is inside the signed message, so it
 *  cannot be moved forward to refresh an expired token — that fails as `signature`. */
export async function verifyRequestBoundToken(
  secret: string,
  label: string,
  subject: string,
  presented: string,
  now: number = Date.now(),
): Promise<RequestBoundResult> {
  const dot = presented.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const ts = Number(presented.slice(0, dot));
  if (!Number.isInteger(ts)) return { ok: false, reason: 'malformed' };
  // Signature FIRST: a token whose timestamp we have not authenticated has not told us
  // anything yet, and reporting skew for an unsigned value would be a lie.
  if (!(await verifyMessage(secret, boundMessage(label, subject, ts), presented.slice(dot + 1)))) {
    return { ok: false, reason: 'signature' };
  }
  if (Math.abs(now - ts) > REQUEST_BOUND_WINDOW_MS) return { ok: false, reason: 'skew' };
  return { ok: true };
}
