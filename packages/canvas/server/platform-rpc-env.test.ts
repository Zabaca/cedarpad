import { describe, expect, test } from 'bun:test';

import { LOCAL_DEV_PLATFORM_SECRET } from '../shared/platform-rpc.ts';
import { workspaceKey } from '../shared/workspace-key.ts';
import { platformRpcFromEnv, withDevWorkspaceKey } from './platform-rpc-env.ts';

// #374: a container process holds its workspace's key (WORKSPACE_KEY), never the shared secret.
// Local dev has no edge to hand it one, so the process derives its own workspace's key from the
// dev secret, and only for an edge on localhost.

const LOCAL = 'http://localhost:4513';

describe('withDevWorkspaceKey', () => {
  test('derives the same key the edge derives, so the dev hop authenticates', async () => {
    // Node's HMAC here, WebCrypto at the edge: one value.
    const env = withDevWorkspaceKey({ PLATFORM_RPC_ORIGIN: LOCAL, BETTER_AUTH_SECRET: 'dev-secret-0123456789', CANVAS_WORKSPACE: 'ws_a' });
    expect(env.WORKSPACE_KEY).toBe(await workspaceKey('dev-secret-0123456789', 'ws_a'));
  });

  test('falls back to the dev secret and the `default` workspace, as the edge does', async () => {
    const env = withDevWorkspaceKey({ PLATFORM_RPC_ORIGIN: LOCAL });
    expect(env.WORKSPACE_KEY).toBe(await workspaceKey(LOCAL_DEV_PLATFORM_SECRET, 'default'));
  });

  test('a key the container was handed wins and is never replaced', () => {
    const env = withDevWorkspaceKey({ PLATFORM_RPC_ORIGIN: LOCAL, WORKSPACE_KEY: 'handed-down', BETTER_AUTH_SECRET: 'x' });
    expect(env.WORKSPACE_KEY).toBe('handed-down');
  });

  test('derives nothing for an edge that is not on localhost: an unkeyed process there is unconfigured', () => {
    for (const origin of ['https://app.cedarpad.com', 'http://localhost.evil.example', undefined]) {
      const env = withDevWorkspaceKey({ ...(origin ? { PLATFORM_RPC_ORIGIN: origin } : {}), BETTER_AUTH_SECRET: 'prod-secret-should-not-be-here' });
      expect(env.WORKSPACE_KEY, String(origin)).toBeUndefined();
    }
  });
});

describe('platformRpcFromEnv', () => {
  test('builds a client from the workspace key', () => {
    expect(platformRpcFromEnv({ PLATFORM_RPC_ORIGIN: 'https://app.cedarpad.com', WORKSPACE_KEY: 'k' })).not.toBeNull();
  });

  test('the shared secret alone is not a credential: no client without a workspace key', () => {
    expect(platformRpcFromEnv({ PLATFORM_RPC_ORIGIN: 'https://app.cedarpad.com', BETTER_AUTH_SECRET: 'secret' })).toBeNull();
    expect(platformRpcFromEnv({ PLATFORM_RPC_ORIGIN: LOCAL, BETTER_AUTH_SECRET: 'secret' })).toBeNull();
  });

  test('no edge origin, no client', () => {
    expect(platformRpcFromEnv({ WORKSPACE_KEY: 'k' })).toBeNull();
  });
});
