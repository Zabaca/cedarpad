import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realMcpTokens from '../web-poc/lib/db/queries/mcp-tokens.ts';

// The shared header-attach helper used by both proxy points (worker/index.ts's same-origin
// fallthrough and worker/inbox-bridge.ts). Exercised directly so its own contract — no
// connected tokens ⇒ the request passes through UNTOUCHED (not just header-less) — is pinned
// independent of either call site.

let tokens: Record<string, string> = {};

// Delegate + restore (see worker/index.test.ts and mcp-tokens-api.test.ts): bun's mock.module rebinds
// the module for every LATER test file in this process, and the order test files run in is the file
// system's, not alphabetical. A mock that offered only `listTokens` and was never undone made
// mcp-tokens-api.test.ts fail to import `setToken` when it ran after this file, and its own leaked
// mock then broke every real-DB suite after it (platform RPC, members, shell, mcp tools...): 86
// failures on a runner whose directory order differed from the one the suite had passed on. So keep
// every export, swap only `listTokens`, and hand it back after this file. The real function is
// captured BY VALUE first (the live namespace would resolve to the wrapper itself).
const realListTokens = realMcpTokens.listTokens;
let listTokensImpl: typeof realListTokens = () => Promise.resolve(tokens);

mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('../web-poc/lib/db/queries/mcp-tokens.ts', () => ({
  ...realMcpTokens,
  listTokens: (...args: Parameters<typeof realListTokens>) => listTokensImpl(...args),
}));
afterAll(() => {
  listTokensImpl = realListTokens;
});

const { withMcpTokensHeader, IS_CHAT_SEND } = await import('./mcp-tokens-proxy.ts');

beforeEach(() => {
  tokens = {};
});

describe('withMcpTokensHeader', () => {
  test('a connected workspace gets the encoded x-mcp-tokens header', async () => {
    tokens = { ledgerbot: 'tok_a' };
    const req = new Request('https://app.cedarpad.com/api/chat/c1/send', { method: 'POST' });
    const out = await withMcpTokensHeader(req, {} as never, 'ws_1');
    expect(out.headers.get('x-mcp-tokens')).toBe(JSON.stringify({ ledgerbot: 'tok_a' }));
  });

  test('an unconnected workspace’s request passes through untouched (the SAME request, no header)', async () => {
    const req = new Request('https://app.cedarpad.com/api/chat/c1/send', { method: 'POST' });
    const out = await withMcpTokensHeader(req, {} as never, 'ws_1');
    expect(out).toBe(req);
    expect(out.headers.get('x-mcp-tokens')).toBeNull();
  });

  test('FREDRIN_KEY connects fredrin for the DEFAULT workspace only (env fallback)', async () => {
    const env = { FREDRIN_KEY: 'fk_secret' } as never;
    const def = await withMcpTokensHeader(new Request('https://x/api/chat/c1/send', { method: 'POST' }), env, 'default');
    expect(def.headers.get('x-mcp-tokens')).toBe(JSON.stringify({ fredrin: 'fk_secret' }));

    const other = await withMcpTokensHeader(new Request('https://x/api/chat/c1/send', { method: 'POST' }), env, 'ws_1');
    expect(other.headers.get('x-mcp-tokens')).toBeNull();
  });

  test('FREDRIN_<LABEL>_KEY connects a named fredrin-<label> connection, default workspace only', async () => {
    const env = { FREDRIN_KEY: 'fk_main', FREDRIN_CEDARPAD_KEY: 'fk_cp', FREDRIN_ACME_WEB_KEY: 'fk_aw', FREDRIN_BOGUS: 'x', OTHER_KEY: 'y' } as never;
    const def = await withMcpTokensHeader(new Request('https://x/api/chat/c1/send', { method: 'POST' }), env, 'default');
    expect(JSON.parse(def.headers.get('x-mcp-tokens') ?? '{}')).toEqual({
      fredrin: 'fk_main',
      'fredrin-cedarpad': 'fk_cp',
      'fredrin-acme-web': 'fk_aw',
    });

    const other = await withMcpTokensHeader(new Request('https://x/api/chat/c1/send', { method: 'POST' }), env, 'ws_1');
    expect(other.headers.get('x-mcp-tokens')).toBeNull();
  });

  test('a stored per-workspace fredrin token wins over the env fallback', async () => {
    tokens = { fredrin: 'tok_db' };
    const env = { FREDRIN_KEY: 'fk_secret' } as never;
    const out = await withMcpTokensHeader(new Request('https://x/api/chat/c1/send', { method: 'POST' }), env, 'default');
    expect(JSON.parse(out.headers.get('x-mcp-tokens') ?? '{}')).toEqual({ fredrin: 'tok_db' });
  });
});

describe('IS_CHAT_SEND', () => {
  test('matches only a chat send path', () => {
    expect(IS_CHAT_SEND.test('/api/chat/c1/send')).toBe(true);
    expect(IS_CHAT_SEND.test('/api/chat/c1/transcript')).toBe(false);
    expect(IS_CHAT_SEND.test('/api/alive')).toBe(false);
  });
});
