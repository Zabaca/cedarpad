import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The shared header-attach helper used by both proxy points (worker/index.ts's same-origin
// fallthrough and worker/inbox-bridge.ts). Exercised directly so its own contract — no
// connected tokens ⇒ the request passes through UNTOUCHED (not just header-less) — is pinned
// independent of either call site.

let tokens: Record<string, string> = {};

mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('../web-poc/lib/db/queries/mcp-tokens.ts', () => ({
  listTokens: () => Promise.resolve(tokens),
}));

const { withMcpTokensHeader, IS_CHAT_SEND } = await import('./mcp-tokens-proxy.ts');

beforeEach(() => {
  tokens = {};
});

describe('withMcpTokensHeader', () => {
  test('a connected workspace gets the encoded x-mcp-tokens header', async () => {
    tokens = { ledgerbot: 'tok_a' };
    const req = new Request('https://poc.cedarpad.com/api/chat/c1/send', { method: 'POST' });
    const out = await withMcpTokensHeader(req, {} as never, 'ws_1');
    expect(out.headers.get('x-mcp-tokens')).toBe(JSON.stringify({ ledgerbot: 'tok_a' }));
  });

  test('an unconnected workspace’s request passes through untouched (the SAME request, no header)', async () => {
    const req = new Request('https://poc.cedarpad.com/api/chat/c1/send', { method: 'POST' });
    const out = await withMcpTokensHeader(req, {} as never, 'ws_1');
    expect(out).toBe(req);
    expect(out.headers.get('x-mcp-tokens')).toBeNull();
  });
});

describe('IS_CHAT_SEND', () => {
  test('matches only a chat send path', () => {
    expect(IS_CHAT_SEND.test('/api/chat/c1/send')).toBe(true);
    expect(IS_CHAT_SEND.test('/api/chat/c1/transcript')).toBe(false);
    expect(IS_CHAT_SEND.test('/api/alive')).toBe(false);
  });
});
