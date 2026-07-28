import { describe, expect, test } from 'bun:test';
import { devWorkerConfig } from './dev-worker-config.ts';

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

describe('devWorkerConfig: the edge Worker as local dev runs it', () => {
  const dev = devWorkerConfig(base, '/wt/packages/canvas', 'http://localhost:4520');

  test('Better Auth points at this stack’s origin, and dev keeps signup open', () => {
    expect(dev.vars).toEqual({
      WEB_ORIGIN: 'http://localhost:4520',
      BETTER_AUTH_URL: 'http://localhost:4520',
      DEV_AGENT_ENABLED: 'false',
      CANVAS_USER: 'usr_1',
    });
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
