import { describe, expect, test } from 'bun:test';
import { openSecret, sealSecret } from './secret-box.ts';

const KEY = 'a-platform-secret-from-sops';

describe('secret box (ADR-0016) — AES-GCM at-rest sealing for stored credentials', () => {
  test('round-trips a token', async () => {
    const sealed = await sealSecret(KEY, 'github_pat_11ABC');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('github_pat_11ABC');
    expect(await openSecret(KEY, sealed)).toBe('github_pat_11ABC');
  });

  test('two seals of the same plaintext differ (fresh IV each time)', async () => {
    const a = await sealSecret(KEY, 'same');
    const b = await sealSecret(KEY, 'same');
    expect(a).not.toBe(b);
    expect(await openSecret(KEY, a)).toBe('same');
    expect(await openSecret(KEY, b)).toBe('same');
  });

  test('the wrong key, a tampered payload, or garbage opens to null — never throws', async () => {
    const sealed = await sealSecret(KEY, 'tok');
    expect(await openSecret('other-key', sealed)).toBeNull();
    const [v, iv, ct] = sealed.split('.');
    const flipped = `${ct?.slice(0, -2)}AA`;
    expect(await openSecret(KEY, `${v}.${iv}.${flipped}`)).toBeNull();
    expect(await openSecret(KEY, 'v1.notreal')).toBeNull();
    expect(await openSecret(KEY, '')).toBeNull();
    expect(await openSecret(KEY, 'v2.a.b')).toBeNull();
  });
});
