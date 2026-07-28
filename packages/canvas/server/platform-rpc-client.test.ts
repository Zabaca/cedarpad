import { describe, expect, test } from 'bun:test';

import { PLATFORM_RPC_PATH, PlatformRpcRequest, platformRpcToken } from '../shared/platform-rpc.ts';
import { platformRpc } from './platform-rpc-client.ts';

// The container half of the platform RPC (ADR-0018). Best-effort by contract: the Conversation
// index and the push doorbell are both "log and continue" today, so an edge that is down must
// degrade exactly as a failed platform-data-layer write does — never failing the turn.

const SECRET = 'better-auth-test-secret';

describe('platform RPC client', () => {
  test('conversation.start posts the derived bearer and the parsed contract', async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const client = platformRpc({
      origin: 'https://app.cedarpad.com',
      secret: SECRET,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ conversationId: 'conv_1' });
      },
    })!;

    await client.conversationStart({ sessionId: 's-1', userId: 'u', workspaceId: 'w', ownerRef: 'chat_A' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://app.cedarpad.com${PLATFORM_RPC_PATH}`);
    expect(calls[0]!.auth).toBe(`Bearer ${await platformRpcToken(SECRET)}`);
    // The body is exactly the shared contract — the edge parses this same schema.
    expect(PlatformRpcRequest.parse(calls[0]!.body).op).toBe('conversation.start');
  });

  test('an unreachable edge is logged and swallowed — the turn continues', async () => {
    const logged: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const client = platformRpc({
        origin: 'https://app.cedarpad.com',
        secret: SECRET,
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      })!;

      // Resolves rather than rejects: an index failure never fails the turn.
      await client.conversationStart({ sessionId: 's-1', userId: 'u', workspaceId: 'w' });
      await client.notify({ conversationId: 'conv_1', question: 'which branch?' });
    } finally {
      console.error = realError;
    }
    expect(logged).toHaveLength(2);
    expect(String(logged[0])).toContain('platform-rpc');
  });

  test('unconfigured (no origin) yields no client, so the caller keeps its local path', () => {
    expect(platformRpc({ origin: '', secret: SECRET })).toBeNull();
    expect(platformRpc({ origin: 'https://app.cedarpad.com', secret: '' })).toBeNull();
  });
});
