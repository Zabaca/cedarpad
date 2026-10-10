import { beforeEach, describe, expect, test } from 'bun:test';

import { JWKS_MIN_REFRESH_MS, JWKS_TTL_MS, resetJwksCache, verifyAssertion } from './access-jwt.ts';
import { AUD, NOW, TEAM, goodClaims, jwksPort, mint, sign } from './access-testkit.ts';

// The admin host's second key (ADR-0026): every branch reached with our own RSA key and a
// JWKS served through the fetch port — no network, no Zero Trust organisation.

const signer = await mint('k1');
const stranger = await mint('k1'); // same kid, different key: a forgery

const deps = (port: ReturnType<typeof jwksPort>, now = NOW) => ({ fetch: port.fetch, teamDomain: TEAM, aud: AUD, now });

beforeEach(() => resetJwksCache());

describe('verifyAssertion', () => {
  test('a valid assertion names its person', async () => {
    const v = await verifyAssertion(await sign(signer, goodClaims()), deps(jwksPort([signer])));
    expect(v).toEqual({ kind: 'ok', subject: 'james@zabaca.com' });
  });

  test('refuses an empty or malformed token without a key fetch', async () => {
    const port = jwksPort([signer]);
    for (const jwt of ['', 'a.b', 'not.a.jwt', 'x'.repeat(9000)]) {
      expect((await verifyAssertion(jwt, deps(port))).kind).toBe('refused');
    }
    expect(port.reads).toBe(0);
  });

  test('refuses the wrong issuer, audience, an expired or not-yet-valid token', async () => {
    const port = jwksPort([signer]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ iss: 'https://other.cloudflareaccess.com' }, 'iss'],
      [{ aud: ['00'.repeat(32)] }, 'aud'],
      [{ exp: NOW / 1000 - 1 }, 'exp'],
      [{ nbf: NOW / 1000 + 60 }, 'nbf'],
    ];
    for (const [extra, why] of cases) {
      expect(await verifyAssertion(await sign(signer, goodClaims(extra)), deps(port))).toEqual({ kind: 'refused', why });
    }
  });

  test('refuses a non-RS256 header and a signature from another key', async () => {
    const port = jwksPort([signer]);
    const none = await sign(signer, goodClaims(), { alg: 'none', kid: 'k1' });
    expect(await verifyAssertion(none, deps(port))).toEqual({ kind: 'refused', why: 'alg' });
    expect(await verifyAssertion(await sign(stranger, goodClaims()), deps(port))).toEqual({ kind: 'refused', why: 'signature' });
  });

  test('fails closed when the key server is down', async () => {
    const port = jwksPort([signer]);
    port.status = 500;
    expect(await verifyAssertion(await sign(signer, goodClaims()), deps(port))).toEqual({ kind: 'refused', why: 'keys' });
  });

  test('caches keys, and refetches an unknown kid at most once a minute', async () => {
    const keys = [signer];
    const port = jwksPort(keys);
    const jwt = await sign(signer, goodClaims());
    await verifyAssertion(jwt, deps(port));
    await verifyAssertion(jwt, deps(port, NOW + 1000));
    expect(port.reads).toBe(1);

    // Access rotates: a new kid is published beside the old one.
    const rotated = await mint('k2');
    keys.push(rotated);
    const fresh = await sign(rotated, goodClaims());
    expect((await verifyAssertion(fresh, deps(port, NOW + 2000))).kind).toBe('refused');
    expect(port.reads).toBe(1);
    expect((await verifyAssertion(fresh, deps(port, NOW + JWKS_MIN_REFRESH_MS + 1))).kind).toBe('ok');
    expect(port.reads).toBe(2);
    expect(JWKS_TTL_MS).toBeGreaterThan(JWKS_MIN_REFRESH_MS);
  });
});
