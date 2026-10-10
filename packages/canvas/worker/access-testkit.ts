// Test-only: a Cloudflare Access team of our own — an RSA key, its JWKS served through a
// fetch port, and assertions signed with it. Shared by access-jwt.test.ts and
// admin-page.test.ts; ported from games' apps/server/test/access.ts.

import { issuerOf, jwksUrl } from './access-jwt.ts';

export const TEAM = 'zabaca.cloudflareaccess.com';
export const AUD = '9f'.repeat(32);
export const NOW = 1_800_000_000_000;

export interface Signer {
  kid: string;
  key: CryptoKeyPair;
  jwk: JsonWebKey;
}

const b64url = (bytes: Uint8Array | string): string => {
  const bin = typeof bytes === 'string' ? bytes : Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function mint(kid: string): Promise<Signer> {
  const key = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', key.publicKey)) as JsonWebKey;
  return { kid, key, jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: pub.n, e: pub.e } as JsonWebKey };
}

export async function sign(
  signer: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: signer.kid, typ: 'JWT' },
): Promise<string> {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signer.key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

export const goodClaims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: issuerOf(TEAM),
  aud: [AUD],
  exp: NOW / 1000 + 600,
  iat: NOW / 1000,
  email: 'james@zabaca.com',
  ...extra,
});

/** A fetch port serving `signers`' public keys at the team's JWKS URL, counting reads. */
export function jwksPort(signers: Signer[]) {
  const port = {
    reads: 0,
    status: 200,
    fetch: async (url: string): Promise<Response> => {
      if (url !== jwksUrl(TEAM)) return new Response('nope', { status: 404 });
      port.reads += 1;
      // Read at fetch time, so a test can rotate keys by pushing onto `signers`.
      return new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }), { status: port.status });
    },
  };
  return port;
}
