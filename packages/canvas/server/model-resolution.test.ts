import { describe, expect, test } from 'bun:test';

import { resolveModelForSdk } from './agent.ts';

// The chat's `sonnet` selection must run on Sonnet 5, not the SDK's bundled sonnet alias
// (claude-sonnet-4-6). opus/haiku behavior is unchanged.
describe('resolveModelForSdk', () => {
  test('pins the sonnet alias to the explicit Sonnet 5 id', () => {
    expect(resolveModelForSdk('sonnet')).toBe('claude-sonnet-5');
  });

  test('opus still auto-upgrades to free 1M context (unchanged)', () => {
    expect(resolveModelForSdk('opus')).toBe('opus[1m]');
  });

  test('haiku passes through as the plain alias (SDK resolves the latest)', () => {
    expect(resolveModelForSdk('haiku')).toBe('haiku');
  });

  test('an explicit model id is not remapped', () => {
    expect(resolveModelForSdk('claude-opus-4-8')).toBe('claude-opus-4-8[1m]');
    expect(resolveModelForSdk('claude-sonnet-5')).toBe('claude-sonnet-5');
  });
});
