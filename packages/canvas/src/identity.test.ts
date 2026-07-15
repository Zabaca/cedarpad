// #211: one identity source for components. Session wins; guest is stable per
// browser and ask-once named; everything degrades to guest, never to an error.

import { describe, expect, test } from 'bun:test';

import { colorFor, guestIdentity, resolveIdentity, sessionIdentity } from './identity';

const memStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe('identity resolution', () => {
  test('a session user wins over the guest; name falls back to the email local-part', async () => {
    const u = await resolveIdentity({
      storage: memStorage(),
      fetchSession: async () => ({ id: 'u_1', email: 'james@zabaca.com' }),
    });
    expect(u).toMatchObject({ id: 'u_1', kind: 'user', name: 'james', email: 'james@zabaca.com' });
  });

  test('an explicit account name beats the email fallback', () => {
    expect(sessionIdentity({ id: 'u_1', email: 'james@zabaca.com', name: 'James' }).name).toBe('James');
  });

  test('no session → a guest identity, stable across calls in the same browser', async () => {
    const storage = memStorage();
    const deps = { storage, fetchSession: async () => null };
    const a = await resolveIdentity(deps);
    const b = await resolveIdentity(deps);
    expect(a.kind).toBe('guest');
    expect(a.id).toMatch(/^guest_/);
    expect(b.id).toBe(a.id);
    expect(a.name).toBeUndefined(); // no invented names — ask-once via setDisplayName
  });

  test('a session fetch FAILURE degrades to guest (local dev has no auth endpoint)', async () => {
    const u = await resolveIdentity({
      storage: memStorage(),
      fetchSession: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(u.kind).toBe('guest');
  });

  test('a stored guest name is picked up', async () => {
    const storage = memStorage();
    storage.setItem('cedarpad:guest-name', 'Jimbo');
    const u = await resolveIdentity({ storage, fetchSession: async () => null });
    expect(u.name).toBe('Jimbo');
  });

  test('color is deterministic per id and travels with the identity', () => {
    expect(colorFor('u_1')).toBe(colorFor('u_1'));
    expect(guestIdentity(memStorage()).color).toMatch(/^hsl\(/);
    expect(sessionIdentity({ id: 'u_1' }).color).toBe(colorFor('u_1'));
  });
});
