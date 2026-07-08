import { describe, expect, test } from 'bun:test';

import { decideGate, isPublicPath } from './auth-gate.ts';

describe('isPublicPath — served without a session so a user can authenticate at the edge', () => {
  test('health, Better Auth endpoints, and the build stamp are public', () => {
    expect(isPublicPath('/health')).toBe(true);
    expect(isPublicPath('/api/auth')).toBe(true);
    expect(isPublicPath('/api/auth/sign-in/email')).toBe(true);
    // #74: the container's build stamp is polled by deploy.sh without a session.
    expect(isPublicPath('/api/buildrev')).toBe(true);
  });

  test('app routes and the workspace proxy are NOT public', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/api/observations')).toBe(false);
    expect(isPublicPath('/v1/problems')).toBe(false);
    // #74: the sensitive/mutating sibling routes stay gated — only buildrev is public.
    expect(isPublicPath('/api/status')).toBe(false);
    expect(isPublicPath('/__recycle')).toBe(false);
    expect(isPublicPath('/__bootlog')).toBe(false);
    // A path that merely mentions api/auth deeper in is not the auth mount.
    expect(isPublicPath('/w/x/api/auth')).toBe(false);
  });
});

describe('decideGate — pure edge gate decision (DENY paths covered explicitly)', () => {
  const user = { id: 'user_123' };

  test('no session ⇒ deny (never reaches the container proxy)', () => {
    expect(decideGate('/', null)).toEqual({ decision: 'deny' });
    expect(decideGate('/api/observations', null)).toEqual({ decision: 'deny' });
  });

  test('expired/invalid session resolves to null ⇒ deny', () => {
    // Better Auth returns null for an expired or tampered session; the gate denies.
    expect(decideGate('/canvas', null)).toEqual({ decision: 'deny' });
  });

  test('valid session ⇒ allow, carrying the resolved user', () => {
    expect(decideGate('/', { user })).toEqual({ decision: 'allow', user });
  });

  test('public paths allow even with no session (so login can happen at the edge)', () => {
    expect(decideGate('/health', null)).toEqual({ decision: 'allow', user: null });
    expect(decideGate('/api/auth/sign-in/email', null)).toEqual({ decision: 'allow', user: null });
  });
});
