// Secret box (ADR-0016): AES-GCM sealing for credentials stored at the edge DB
// (today: workspace repo PATs). Keyed by a platform secret delivered like
// BETTER_AUTH_SECRET (SOPS → worker secret), stretched to a key via SHA-256.
// Format: `v1.<b64url iv>.<b64url ciphertext>`. Decrypt failures return null —
// callers treat an unopenable credential like a missing one.

const VERSION = 'v1';

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const toB64url = (buf: ArrayBuffer | Uint8Array): string => Buffer.from(buf as Uint8Array).toString('base64url');
// Annotated `Uint8Array<ArrayBuffer>` (not the default `Uint8Array<ArrayBufferLike>`)
// because `new Uint8Array(...)` always backs onto a fresh ArrayBuffer here, and
// crypto.subtle's BufferSource param requires that narrower generic.
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, 'base64url'));

/** Seal a plaintext credential for storage. Fresh IV per call. */
export async function sealSecret(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(plaintext));
  return `${VERSION}.${toB64url(iv)}.${toB64url(ct)}`;
}

/** Open a sealed credential. Null on any failure (wrong key, tamper, malformed). */
export async function openSecret(secret: string, sealed: string): Promise<string | null> {
  const [version, ivPart, ctPart, extra] = sealed.split('.');
  if (version !== VERSION || !ivPart || !ctPart || extra !== undefined) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(ivPart) },
      await aesKey(secret),
      fromB64url(ctPart),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
