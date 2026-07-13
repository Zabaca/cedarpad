import { describe, expect, test } from 'bun:test';

// The registry itself is read at module load (from process.env), so we exercise it via
// fresh dynamic imports with the env var toggled around each import — the module-level
// MCP_REGISTRY constant is what a missing env var must degrade, never throw.
describe('MCP_REGISTRY: a missing token/env means "not connected", never a failure', () => {
  test('LEDGERBOT_MCP_URL unset ⇒ no ledgerbot entry at all', async () => {
    const prev = process.env.LEDGERBOT_MCP_URL;
    delete process.env.LEDGERBOT_MCP_URL;
    try {
      const { MCP_REGISTRY } = await import(`./mcp-registry.ts?unset=${Date.now()}`);
      expect(MCP_REGISTRY.ledgerbot).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.LEDGERBOT_MCP_URL = prev;
    }
  });

  test('LEDGERBOT_MCP_URL set ⇒ a bearer entry pointing at it', async () => {
    const prev = process.env.LEDGERBOT_MCP_URL;
    process.env.LEDGERBOT_MCP_URL = 'https://ledgerbot.example/mcp';
    try {
      const { MCP_REGISTRY } = await import(`./mcp-registry.ts?set=${Date.now()}`);
      expect(MCP_REGISTRY.ledgerbot).toEqual({ url: 'https://ledgerbot.example/mcp', auth: 'bearer' });
    } finally {
      if (prev === undefined) delete process.env.LEDGERBOT_MCP_URL;
      else process.env.LEDGERBOT_MCP_URL = prev;
    }
  });
});

describe('encodeMcpTokens / decodeMcpTokens: the shared per-send header contract', () => {
  test('round-trips a workspace’s connected tokens', async () => {
    const { encodeMcpTokens, decodeMcpTokens } = await import('./mcp-registry.ts');
    const tokens = { ledgerbot: 'tok_abc' };
    expect(decodeMcpTokens(encodeMcpTokens(tokens))).toEqual(tokens);
  });

  test('a missing header decodes to no tokens (never throws)', async () => {
    const { decodeMcpTokens } = await import('./mcp-registry.ts');
    expect(decodeMcpTokens(null)).toEqual({});
    expect(decodeMcpTokens(undefined)).toEqual({});
  });

  test('a malformed header (bad JSON, or JSON of the wrong shape) decodes to no tokens', async () => {
    const { decodeMcpTokens } = await import('./mcp-registry.ts');
    expect(decodeMcpTokens('not json')).toEqual({});
    expect(decodeMcpTokens(JSON.stringify({ ledgerbot: 42 }))).toEqual({});
    expect(decodeMcpTokens(JSON.stringify(['array', 'not', 'record']))).toEqual({});
  });
});
