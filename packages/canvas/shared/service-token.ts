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
  const padded = presented.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(presented.length / 4) * 4, '=');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, new TextEncoder().encode(label));
}
