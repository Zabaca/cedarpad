import { describe, expect, test } from 'bun:test';
import { buildClaudeRequest } from './claude.ts';

// The huddle brain (ADR-0017): raw streaming /v1/messages under the subscription OAuth
// token (Bearer + oauth beta + the Claude Code identity as FIRST system block, spiked
// 2026-07-18). An API key, when present, wins with no code change.
const msgs = [{ role: 'user' as const, content: 'Cedar, place the chart' }];

describe('buildClaudeRequest — auth precedence and the OAuth identity contract', () => {
  test('api key path: x-api-key header, plain system string, stream on', () => {
    const r = buildClaudeRequest({ apiKey: 'k', oauthToken: 't' }, 'SYS', msgs, []);
    expect(r.headers['x-api-key']).toBe('k');
    expect(r.headers.authorization).toBeUndefined();
    const body = JSON.parse(r.body);
    expect(body.system).toBe('SYS');
    expect(body.stream).toBe(true);
  });

  test('oauth path: bearer + beta header, CC identity is the first system block', () => {
    const r = buildClaudeRequest({ oauthToken: 't' }, 'SYS', msgs, []);
    expect(r.headers.authorization).toBe('Bearer t');
    expect(r.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    const body = JSON.parse(r.body);
    expect(body.system[0].text).toMatch(/^You are Claude Code/);
    expect(body.system[1].text).toBe('SYS');
  });

  test('no credential throws', () => {
    expect(() => buildClaudeRequest({}, 'SYS', msgs, [])).toThrow();
  });
});
