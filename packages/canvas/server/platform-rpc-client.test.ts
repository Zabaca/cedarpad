import { describe, expect, test } from 'bun:test';

import { PLATFORM_RPC_PATH, PlatformRpcRequest, platformRpcToken } from '../shared/platform-rpc.ts';
import { platformRpc } from './platform-rpc-client.ts';

// The container half of the platform RPC (ADR-0018). Every verb is a Record verb now, and a
// Record verb must FAIL when the edge does: a write that cannot be persisted has to fail its
// tool call rather than succeed to disk and evaporate.

const SECRET = 'better-auth-test-secret';

describe('platform RPC client', () => {
  test('a verb posts the derived bearer and the parsed contract', async () => {
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
        return Response.json({ source: null });
      },
    })!;

    await client.componentRead({ workspaceId: 'w', canvasId: 'c', name: 'Card', tier: 'own' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://app.cedarpad.com${PLATFORM_RPC_PATH}`);
    expect(calls[0]!.auth).toBe(`Bearer ${await platformRpcToken(SECRET)}`);
    // The body is exactly the shared contract — the edge parses this same schema.
    expect(PlatformRpcRequest.parse(calls[0]!.body).op).toBe('component.read');
  });

  test('an unreachable edge THROWS — never a silent "absent"', async () => {
    const client = platformRpc({
      origin: 'https://app.cedarpad.com',
      secret: SECRET,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    })!;

    await expect(client.componentRead({ workspaceId: 'w', canvasId: 'c', name: 'Card', tier: 'own' })).rejects.toThrow();
  });

  test('unconfigured (no origin) yields no client, so the caller keeps its local path', () => {
    expect(platformRpc({ origin: '', secret: SECRET })).toBeNull();
    expect(platformRpc({ origin: undefined, secret: SECRET })).toBeNull();
    expect(platformRpc({ origin: 'https://app.cedarpad.com', secret: '' })).toBeNull();
  });
});
