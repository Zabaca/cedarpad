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
  containers: [{ class_name: 'Sandbox', image: './Dockerfile' }],
  d1_databases: [{ binding: 'WAITLIST', database_name: 'cedarpad-waitlist', database_id: 'w-1' }],
  vars: {
    WEB_ORIGIN: 'https://app.cedarpad.com',
    BETTER_AUTH_URL: 'https://app.cedarpad.com',
    AUTH_DISABLE_SIGNUP: 'true',
    DEV_AGENT_ENABLED: 'true',
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
      DEV_AGENT_ENABLED: 'false',
      CANVAS_USER: 'usr_1',
      // ADR-0018 / #266: the bridge has no database, so it reaches the platform data layer
      // over the RPC — which needs both ends to share a trust root even in a worktree with no
      // `.dev.vars`. `.dev.vars` still wins when it exists (wrangler's own precedence).
      BETTER_AUTH_SECRET: LOCAL_DEV_PLATFORM_SECRET,
    });
  });

  test('no bridge origin ⇒ no e2e container stand-in in the config at all', () => {
    expect(dev.vars).not.toHaveProperty('E2E_MODE');
    expect(dev.vars).not.toHaveProperty('LOCAL_BRIDGE_ORIGIN');
  });

  test('under e2e the edge is told where the bridge is, since local dev has no container (#276)', () => {
    const e2e = devWorkerConfig(base, '/wt/packages/canvas', 'http://localhost:4520', 'http://localhost:4521');
    expect(e2e.vars).toMatchObject({ E2E_MODE: '1', LOCAL_BRIDGE_ORIGIN: 'http://localhost:4521' });
  });

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
    expect(base.d1_databases).toHaveLength(1);
    expect(base.main).toBe('worker/index.ts');
  });
});
