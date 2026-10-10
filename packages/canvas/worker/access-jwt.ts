/**
 * The admin host's second key: a Cloudflare Access assertion, verified here (ADR-0026).
 *
 * Access is an edge control. The Zero Trust application in front of
 * `admin.cedarpad.com` (packages/infra/environments/production/admin-access.ts)
 * sends a person to the team's sign-in page and, once through, forwards the request
 * with a `Cf-Access-Jwt-Assertion` header: an RS256 JWT issued by the team domain,
 * naming the person and the application it was minted for. But this Worker is also
 * reachable on app.cedarpad.com and on workers.dev, where Access is not in
 * front of it, so the assertion is verified again here against the team's published
 * keys — the documented pattern, ported from games' apps/server/src/access.ts.
 *
 * Value-fed: a `fetch`-shaped port, the team domain, the audience tag and the clock.
 * It names no binding, so the suite mints its own RSA key and serves its own JWKS.
 *
 * It FAILS CLOSED. Every throw, timeout, non-200 from the key server and malformed
 * token is `refused`; a verifier that admitted somebody because the key server was
 * slow would be an open door on exactly the day something is wrong.
 *
 * Keys are cached per isolate for JWKS_TTL_MS and refetched once on an unknown kid
 * (Access rotates keys and publishes the new one beside the old), no more often than
 * JWKS_MIN_REFRESH_MS, so a flood of forged kids is one read a minute.
 */

/** Somewhere to send a request. `fetch`, narrowed to what this file uses. */
export type Http = (url: string, init: RequestInit) => Promise<Response>;

/** What a verification needs, all of it a value. */
export interface AccessDeps {
  fetch: Http;
  /** `<team>.cloudflareaccess.com`, bare. The issuer and the JWKS URL derive from it. */
  teamDomain: string;
  /** The application's audience tag: 64 hex characters, off the Access instance's outputs. */
  aud: string;
  /** Milliseconds since the epoch. `exp` and `nbf` are compared against it. */
  now: number;
}

/**
 * `ok` names who the assertion was for -- an address for a person, the token's
 * common name for a machine -- and is for a log line, never for a decision.
 * `refused` says why, for the same log line and for the suite.
 */
export type AccessVerdict =
  | { kind: 'ok'; subject: string }
  | { kind: 'refused'; why: string };

/** The one header Access sets. Lower-case, as `Headers.get` is case-insensitive anyway. */
export const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** How long a fetched key set is trusted before it is read again. */
export const JWKS_TTL_MS = 60 * 60 * 1000;
/**
 * How soon after a read an unknown kid may cost another. A forged assertion
 * carries whatever kid it likes, and without this floor each one would be a
 * subrequest to the key server; with it a flood of them is one read a minute.
 */
export const JWKS_MIN_REFRESH_MS = 60 * 1000;
/** How long the key server gets. A slow key server is a refusal, not a wait. */
export const JWKS_TIMEOUT_MS = 3000;
/** A JWT longer than this is not one Access issued; refused before it is split. */
export const ASSERTION_MAX = 8192;

/** `<team>.cloudflareaccess.com`, the same shape the vendored module accepts. */
export const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
/** An audience tag, as Access mints them. */
export const AUD_TAG = /^[0-9a-f]{64}$/;

/** Where a team's signing keys are published. */
export function jwksUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

/** What `iss` must say. */
export function issuerOf(teamDomain: string): string {
  return `https://${teamDomain}`;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface CachedKeys {
  at: number;
  keys: Map<string, CryptoKey>;
}

const cache = new Map<string, CachedKeys>();

/** Forget every cached key set. For the suite, which wants to count fetches. */
export function resetJwksCache(): void {
  cache.clear();
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/**
 * The team's keys, imported and by kid. `null` when the key server could not
 * be read, which the caller turns into a refusal.
 */
async function readKeys(deps: AccessDeps): Promise<Map<string, CryptoKey> | null> {
  let res: Response;
  try {
    res = await deps.fetch(jwksUrl(deps.teamDomain), {
      method: 'GET',
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const list = (body as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return null;
  const keys = new Map<string, CryptoKey>();
  for (const k of list as Jwk[]) {
    if (typeof k.kid !== 'string' || k.kty !== 'RSA' || typeof k.n !== 'string' || typeof k.e !== 'string') continue;
    if (k.alg !== undefined && k.alg !== 'RS256') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(k.kid, key);
    } catch {
      // A key that will not import is a key we cannot verify with; skip it.
    }
  }
  return keys;
}

/** The key for `kid`: from the cache, else fetched once, else `null`. */
async function keyFor(kid: string, deps: AccessDeps): Promise<CryptoKey | null> {
  const held = cache.get(deps.teamDomain);
  if (held && deps.now - held.at < JWKS_TTL_MS) {
    const key = held.keys.get(kid);
    if (key) return key;
    if (deps.now - held.at < JWKS_MIN_REFRESH_MS) return null;
  }
  const fresh = await readKeys(deps);
  if (fresh === null) return null;
  cache.set(deps.teamDomain, { at: deps.now, keys: fresh });
  return fresh.get(kid) ?? null;
}

/**
 * Is this an assertion the team domain issued for this application, and is it
 * still good? The whole check, in the order it can be answered cheapest.
 */
export async function verifyAssertion(jwt: string, deps: AccessDeps): Promise<AccessVerdict> {
  if (jwt.length === 0 || jwt.length > ASSERTION_MAX) return { kind: 'refused', why: 'shape' };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { kind: 'refused', why: 'shape' };
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown; typ?: unknown };
  let claims: {
    iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown;
    email?: unknown; common_name?: unknown; sub?: unknown;
  };
  try {
    header = b64urlToJson(h) as typeof header;
    claims = b64urlToJson(p) as typeof claims;
  } catch {
    return { kind: 'refused', why: 'shape' };
  }
  if (header === null || typeof header !== 'object' || claims === null || typeof claims !== 'object') {
    return { kind: 'refused', why: 'shape' };
  }
  if (header.alg !== 'RS256') return { kind: 'refused', why: 'alg' };
  if (typeof header.kid !== 'string' || header.kid === '') return { kind: 'refused', why: 'kid' };

  // Claims before the signature: they are free, and a token for another
  // application need not cost a key fetch.
  if (claims.iss !== issuerOf(deps.teamDomain)) return { kind: 'refused', why: 'iss' };
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(deps.aud)) return { kind: 'refused', why: 'aud' };
  const nowS = Math.floor(deps.now / 1000);
  if (typeof claims.exp !== 'number' || !(claims.exp > nowS)) return { kind: 'refused', why: 'exp' };
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowS)) {
    return { kind: 'refused', why: 'nbf' };
  }

  const key = await keyFor(header.kid, deps);
  if (key === null) return { kind: 'refused', why: 'keys' };
  let good = false;
  try {
    good = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    good = false;
  }
  if (!good) return { kind: 'refused', why: 'signature' };

  const subject =
    typeof claims.email === 'string' && claims.email !== '' ? claims.email
    : typeof claims.common_name === 'string' && claims.common_name !== '' ? claims.common_name
    : typeof claims.sub === 'string' ? claims.sub
    : '';
  return { kind: 'ok', subject };
}
