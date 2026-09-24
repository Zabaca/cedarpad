import { describe, expect, test } from 'bun:test';

import { resolveModelForSdk } from './agent.ts';

// The chat's `sonnet`/`opus` selections must run on Sonnet 5 / Opus 5.5, not the SDK's bundled
// aliases (claude-sonnet-4-6 / claude-opus-4-8). haiku behavior is unchanged.
describe('resolveModelForSdk', () => {
  test('pins the sonnet alias to the explicit Sonnet 5 id', () => {
    expect(resolveModelForSdk('sonnet')).toBe('claude-sonnet-5');
  });

  test('pins the opus alias to Opus 5.5 and keeps the free 1M context', () => {
    expect(resolveModelForSdk('opus')).toBe('claude-opus-5-5[1m]');
  });

  test('haiku passes through as the plain alias (SDK resolves the latest)', () => {
    expect(resolveModelForSdk('haiku')).toBe('haiku');
  });

  test('an explicit model id is not remapped', () => {
    expect(resolveModelForSdk('claude-opus-4-8')).toBe('claude-opus-4-8[1m]');
    expect(resolveModelForSdk('claude-sonnet-5')).toBe('claude-sonnet-5');
  });
});
