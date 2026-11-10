import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { devWorkerConfig, parseJsonc } from './dev-worker-config.ts';
import { LOCAL_DEV_PLATFORM_SECRET } from '../shared/platform-rpc.ts';

const base = {
  name: 'agent-canvas',
  main: 'worker/index.ts',
  routes: [{ pattern: 'app.cedarpad.com', custom_domain: true }],
  triggers: { crons: ['0 9 * * *'] },
  assets: { directory: './shell/dist', binding: 'ASSETS', run_worker_first: true },
  containers: [{ class_name: 'CanvasContainer', scheduling_policy: 'durable_object', images: { canvas: { dockerfile: './Dockerfile' } } }],
  d1_databases: [
    { binding: 'WAITLIST', database_name: 'cedarpad-waitlist', database_id: 'w-1' },
    { binding: 'PLATFORM_DB', database_name: 'cedarpad-platform', database_id: 'remote-1' },
  ],
  vars: {
    WEB_ORIGIN: 'https://app.cedarpad.com',
    BETTER_AUTH_URL: 'https://app.cedarpad.com',
    AUTH_DISABLE_SIGNUP: 'true',
    CANVAS_USER: 'usr_1',
  },
  env: { preview: { name: 'agent-canvas-preview' } },
};

describe('parseJsonc: read wrangler.jsonc without depending on the runtime’s loader', () => {
  test('drops comments but never touches comment-like text inside strings', () => {
    const text = `{
      // the deployed worker
      "name": "agent-canvas", /* inline */
      "url": "https://app.cedarpad.com", // trailing
      "path": "a/*not a comment*/b"
    }`;
    expect(parseJsonc(text)).toEqual({
      name: 'agent-canvas',
      url: 'https://app.cedarpad.com',
      path: 'a/*not a comment*/b',
    });
  });

  test('parses the real wrangler.jsonc', () => {
    const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect((parseJsonc(text) as { name: string }).name).toBe('agent-canvas');
  });
});

describe('devWorkerConfig: the edge Worker as local dev runs it', () => {
  const dev = devWorkerConfig(base, '/wt/packages/canvas', 'http://localhost:4520');

  test('Better Auth points at this stack’s origin, and dev keeps signup open', () => {
    expect(dev.vars).toEqual({
      WEB_ORIGIN: 'http://localhost:4520',
      BETTER_AUTH_URL: 'http://localhost:4520',
      CANVAS_USER: 'usr_1',
      // ADR-0018 / #266: the bridge has no database, so it reaches the platform data layer
      // over the RPC — which needs both ends to share a trust root even in a worktree with no
      // `.dev.vars`. `.dev.vars` still wins when it exists (wrangler's own precedence).
      BETTER_AUTH_SECRET: LOCAL_DEV_PLATFORM_SECRET,
    });
  });

  test('no bridge origin ⇒ no container stand-in in the config at all', () => {
    expect(dev.vars).not.toHaveProperty('LOCAL_CONTAINER_SHIM');
    expect(dev.vars).not.toHaveProperty('LOCAL_BRIDGE_ORIGIN');
  });

  test('given a bridge origin the edge is told where it is, since local dev has no container (#276)', () => {
    const local = devWorkerConfig(base, '/wt/packages/canvas', 'http://localhost:4520', 'http://localhost:4521');
    expect(local.vars).toMatchObject({ LOCAL_CONTAINER_SHIM: '1', LOCAL_BRIDGE_ORIGIN: 'http://localhost:4521' });
  });

  // The stand-in is a LOCAL DEV fact, not an e2e one. It used to ride on `E2E_MODE`, which
  // also swaps the bridge's Claude SDK turn for a stub (server/bridge.ts) — so the only way
  // to make the Shell's canvas stage work locally was to silently fake the agent, and a plain
  // `bun run dev` instead died on "Containers have not been enabled". Separate flags.
  test('the container stand-in never implies the e2e agent stub', () => {
    const local = devWorkerConfig(base, '/wt/packages/canvas', 'http://localhost:4520', 'http://localhost:4521');
    expect(local.vars).not.toHaveProperty('E2E_MODE');
  });

  // Since #265 wrangler.jsonc declares a PRODUCTION PLATFORM_DB. Local dev must replace it,
  // not append to it: two bindings of one name is a wrangler error, and the surviving id
  // must never be the remote database's.
  test('binds the platform data layer to a local D1 alongside the waitlist D1', () => {
    expect(dev.d1_databases).toEqual([
      { binding: 'WAITLIST', database_name: 'cedarpad-waitlist', database_id: 'w-1' },
      {
        binding: 'PLATFORM_DB',
        database_name: 'cedarpad-platform',
        database_id: 'local-dev',
        migrations_dir: '/wt/packages/canvas/web-poc/lib/db/migrations',
      },
    ]);
  });

  test('resolves entry and assets against the package, not the generated file', () => {
    expect(dev.main).toBe('/wt/packages/canvas/worker/index.ts');
    expect((dev.assets as { directory: string }).directory).toBe('/wt/packages/canvas/shell/dist');
  });

  test('claims no production routes, crons, containers, or named environments', () => {
    expect(dev.routes).toBeUndefined();
    expect(dev.triggers).toBeUndefined();
    expect(dev.containers).toBeUndefined();
    expect(dev.env).toBeUndefined();
  });

  test('leaves the base config object untouched', () => {
    expect(base.d1_databases).toHaveLength(2);
    expect(base.main).toBe('worker/index.ts');
  });
});
