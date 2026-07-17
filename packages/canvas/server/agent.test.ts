import { describe, expect, test } from 'bun:test';

import { buildExternalMcpServers } from './agent.ts';

// ADR-0013 train 2 (#176): `buildExternalMcpServers` is the container-side half of the registry
// contract — it turns "which registry servers did this request name a token for" into the
// SDK's `mcpServers` shape. A fake registry is injected (the default-parameter test seam) so
// these tests don't depend on LEDGERBOT_MCP_URL / process.env (that gating is pinned in
// server/mcp-registry.test.ts).

const fakeRegistry = { ledgerbot: { url: 'https://ledgerbot.example/mcp', auth: 'bearer' as const } };

describe('buildExternalMcpServers: this turn’s external MCP servers from a registry + tokens', () => {
  test('a registry entry with a matching token becomes an http server with a Bearer header', () => {
    expect(buildExternalMcpServers({ ledgerbot: 'tok_abc' }, fakeRegistry)).toEqual({
      ledgerbot: { type: 'http', url: 'https://ledgerbot.example/mcp', headers: { authorization: 'Bearer tok_abc' } },
    });
  });

  test('no token for a registry entry ⇒ that server is absent entirely (no connection attempt)', () => {
    expect(buildExternalMcpServers({}, fakeRegistry)).toEqual({});
  });

  test('a token for a name NOT in the registry is ignored (the registry — not the token — gates)', () => {
    expect(buildExternalMcpServers({ ledgerbot: 'tok_abc' }, {})).toEqual({});
  });

  test('no mcpTokens at all (dev-agent turns) ⇒ no external servers', () => {
    expect(buildExternalMcpServers(undefined, fakeRegistry)).toEqual({});
  });
});

// The end_turn summary line: a required summary made a question-only needs_human call fail
// schema validation, forcing a visible retry (the doubled end_turn transcript bug).
import { endTurnSummaryLine, sendMessageOp } from './agent.ts';

describe('endTurnSummaryLine: end_turn works without an explicit summary', () => {
  test('an explicit summary wins', () => {
    expect(endTurnSummaryLine('shipped it', 'ignored?')).toBe('shipped it');
  });

  test('question-only (the Stop-gate-nudged path) derives the line from the question', () => {
    expect(endTurnSummaryLine(undefined, 'Should I build cross-chat messaging?')).toBe('Should I build cross-chat messaging?');
  });

  test('a long question is truncated to one Inbox line', () => {
    const q = 'x'.repeat(200);
    expect(endTurnSummaryLine(undefined, q)).toBe(`${'x'.repeat(140)}…`);
  });

  test('neither ⇒ a plain fallback, never a schema failure', () => {
    expect(endTurnSummaryLine(undefined, undefined)).toBe('Turn complete.');
  });
});

// Cross-chat send_message: guard rails around the bridge-bound seam.
import { createStore } from '../src/store.ts';

describe('sendMessageOp: the send_message tool body', () => {
  const chatShape = { id: 'shape:target', type: 'chat', x: 0, y: 0, w: 100, h: 100, color: 'black' } as never;

  test('delivers to another chat card with origin attribution, routed on the sender canvas', () => {
    const store = createStore([chatShape]);
    const calls: unknown[] = [];
    const text = sendMessageOp(store, (id, msg, canvas) => (calls.push([id, msg, canvas]), { ok: true }), { chat_id: 'shape:target', message: 'ping' }, 'shape:origin', 'cv_1');
    expect(calls).toEqual([['shape:target', '[from shape:origin] ping', 'cv_1']]);
    expect(text).toContain('Delivered');
  });

  test('refuses a self-send', () => {
    const store = createStore([chatShape]);
    const text = sendMessageOp(store, () => ({ ok: true }), { chat_id: 'shape:origin', message: 'hi' }, 'shape:origin');
    expect(text).toContain('YOUR OWN chat');
  });

  test('refuses a target that is not a chat card on this canvas', () => {
    const store = createStore([]);
    const text = sendMessageOp(store, () => ({ ok: true }), { chat_id: 'shape:ghost', message: 'hi' }, 'shape:origin');
    expect(text).toContain('No chat card');
  });

  test('surfaces a seam refusal (target turn in flight) to the agent', () => {
    const store = createStore([chatShape]);
    const text = sendMessageOp(store, () => ({ ok: false, error: 'turn in flight' }), { chat_id: 'shape:target', message: 'hi' }, 'shape:origin');
    expect(text).toContain('Not delivered: turn in flight');
  });
});
