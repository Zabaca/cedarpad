import { describe, expect, test } from 'bun:test';

import { platformRpcToken, verifyPlatformRpcToken } from '../shared/platform-rpc.ts';
import { workspaceKey } from '../shared/workspace-key.ts';
import { containerEnv } from './container-env.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

// A container serves every member of its workspace, so it is handed no user identity: a
// write's author arrives per request (x-canvas-author), never as one fixed env var.
describe('containerEnv — the workspace, not a user', () => {
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('carries the workspace coord and no CANVAS_USER, even if the Worker env still has one', async () => {
    const env = { CANVAS_USER: 'user_abc123' } as never;
    expect((await containerEnv(env, coords)).CANVAS_WORKSPACE).toBe('default');
    expect(Object.keys(await containerEnv(env, coords))).not.toContain('CANVAS_USER');
  });
});

describe('containerEnv — a fixed field list', () => {
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('containerEnv reads only its fixed fields, so nothing else in the Worker env can ride along', async () => {
    expect(containerEnv.length).toBe(2);
    const env = { PLATFORM_DB: 'x' } as never;
    const result = await containerEnv(env, coords);
    // containerEnv only reads the fixed field list below, whatever else the Env holds.
    expect(Object.keys(result).sort()).toEqual(
      [
        'CANVAS_CWD',
        'CANVAS_WORKSPACE',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'PLATFORM_RPC_ORIGIN',
        'WORKSPACE_BLOBS',
        'WORKSPACE_KEY',
      ].sort(),
    );
  });

  // ADR-0018 / #266 — THE decision, as a test: the container is handed no way to reach a
  // datastore. Not "does not use one" — cannot. This is the assertion that fails if anyone
  // re-adds the forwarding lines, so it names the values rather than the variables.
  test('no platform data layer credentials reach the container', async () => {
    const env = {
      PLATFORM_DB: 'fake-d1-binding',
      VOYAGE_API_KEY: 'voyage_fake_key',
    } as never;

    const result = await containerEnv(env, coords);

    expect(Object.keys(result)).not.toContain('PLATFORM_DB');
    expect(Object.values(result)).not.toContain('fake-d1-binding');
    // VOYAGE_API_KEY went with the same mount: embeddings are a Notebook (edge) concern.
    expect(Object.values(result)).not.toContain('voyage_fake_key');
  });

  test('an Env carrying connector-secret-shaped fields (slack, stripe) does not surface them', async () => {
    const env = { slack: 'xoxb-fake-token', stripe: 'sk_fake_key' } as never;
    const result = await containerEnv(env, coords);
    expect(Object.values(result)).not.toContain('xoxb-fake-token');
    expect(Object.values(result)).not.toContain('sk_fake_key');
  });
});

// #374: the container is handed its WORKSPACE's key and never the secret the keys derive from.
describe('containerEnv: the container holds a workspace key, not BETTER_AUTH_SECRET (#374)', () => {
  const SECRET = 'better-auth-test-secret';
  const coordsFor = (canvasWorkspace: string): SandboxCoords => ({ sandboxId: `s-${canvasWorkspace}`, r2Prefix: `workspaces/${canvasWorkspace}/`, canvasWorkspace });
  const env = { BETTER_AUTH_SECRET: SECRET } as never;

  test('the shared secret is not in the container env, under any name or inside any value', async () => {
    const result = await containerEnv(env, coordsFor('ws_a'));
    expect(Object.keys(result)).not.toContain('BETTER_AUTH_SECRET');
    for (const value of Object.values(result)) expect(String(value)).not.toContain(SECRET);
  });

  test("the key is the workspace's own, so it verifies a bearer for that workspace only", async () => {
    const a = (await containerEnv(env, coordsFor('ws_a'))).WORKSPACE_KEY!;
    const b = (await containerEnv(env, coordsFor('ws_b'))).WORKSPACE_KEY!;
    expect(a).toBe(await workspaceKey(SECRET, 'ws_a'));
    expect(a).not.toBe(b);
    // What the container derives from its key is accepted for its workspace and not for the other.
    const bearerA = await platformRpcToken(a);
    expect(await verifyPlatformRpcToken(await workspaceKey(SECRET, 'ws_a'), bearerA)).toBe(true);
    expect(await verifyPlatformRpcToken(await workspaceKey(SECRET, 'ws_b'), bearerA)).toBe(false);
  });

  test('the legacy default workspace gets the key of `default`, which the legacy default canvas is checked against', async () => {
    const result = await containerEnv(env, coordsFor('default'));
    expect(result.WORKSPACE_KEY).toBe(await workspaceKey(SECRET, 'default'));
  });

  test('an edge with no secret configured hands out no key, so the container is unconfigured rather than keyed to nothing', async () => {
    expect((await containerEnv({} as never, coordsFor('ws_a'))).WORKSPACE_KEY).toBe('');
  });
});

// The container reaches the bucket only through the edge (shared/workspace-blob.ts), so it is
// handed no R2 credential: with the shared bucket's keys one workspace's container could read or
// overwrite another's objects without touching the edge.
describe('containerEnv: no R2 credential (the bucket is reached through the edge)', () => {
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('the Worker may hold the bucket\'s S3 keys and none of it reaches the container', async () => {
    const env = { R2_BUCKET: 'fake-bucket-name', R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_ACCESS_KEY_ID: 'AKIAFAKE', R2_SECRET_ACCESS_KEY: 'fake-r2-secret' } as never;
    const result = await containerEnv(env, coords);
    expect(Object.keys(result).filter((k) => k.startsWith('R2_'))).toEqual([]);
    for (const v of ['fake-bucket-name', 'acct.r2.cloudflarestorage.com', 'AKIAFAKE', 'fake-r2-secret']) {
      expect(Object.values(result).some((value) => String(value).includes(v)), v).toBe(false);
    }
  });

  test('it is told to use the edge door for its blobs', async () => {
    expect((await containerEnv({} as never, coords)).WORKSPACE_BLOBS).toBe('edge');
  });
});
