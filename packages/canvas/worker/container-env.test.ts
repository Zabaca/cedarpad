import { describe, expect, test } from 'bun:test';

import { containerEnv } from './container-env.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

// Regression: `ask_human` files every Conversation under `process.env.CANVAS_USER ??
// 'default'` (server/bridge.ts), and the Inbox UI queries by the real Better Auth
// user.id — so if this Worker-side env var isn't forwarded into the container's
// process env, promoted items silently never appear in the Inbox (no error, no visible
// failure — the conversation just never matches anyone's query).
describe('containerEnv — CANVAS_USER forwarding', () => {
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('forwards CANVAS_USER from the Worker env into the container env', () => {
    const env = { CANVAS_USER: 'user_abc123' } as never;
    expect(containerEnv(env, coords).CANVAS_USER).toBe('user_abc123');
  });

  test('falls back to an empty string when unset, matching the other optional fields', () => {
    const env = {} as never;
    expect(containerEnv(env, coords).CANVAS_USER).toBe('');
  });
});

describe('containerEnv — a fixed field list', () => {
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('containerEnv reads only its fixed fields — nothing else in the Worker env can ride along', () => {
    expect(containerEnv.length).toBe(2);
    const env = { CANVAS_USER: 'user_abc123' } as never;
    const result = containerEnv(env, coords);
    // containerEnv only reads the fixed field list below, whatever else the Env holds.
    expect(Object.keys(result).sort()).toEqual(
      [
        'BETTER_AUTH_SECRET',
        'CANVAS_CWD',
        'CANVAS_USER',
        'CANVAS_WORKSPACE',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'PLATFORM_RPC_ORIGIN',
        'R2_ACCESS_KEY_ID',
        'R2_BUCKET',
        'R2_ENDPOINT',
        'R2_SECRET_ACCESS_KEY',
      ].sort(),
    );
  });

  // ADR-0018 / #266 — THE decision, as a test: the container is handed no way to reach a
  // datastore. Not "does not use one" — cannot. This is the assertion that fails if anyone
  // re-adds the forwarding lines, so it names the values rather than the variables.
  test('no platform data layer credentials reach the container', () => {
    const env = {
      PLATFORM_DB: 'fake-d1-binding',
      VOYAGE_API_KEY: 'voyage_fake_key',
      CANVAS_USER: 'u',
    } as never;

    const result = containerEnv(env, coords);

    expect(Object.keys(result)).not.toContain('PLATFORM_DB');
    expect(Object.values(result)).not.toContain('fake-d1-binding');
    // VOYAGE_API_KEY went with the same mount: embeddings are a Notebook (edge) concern.
    expect(Object.values(result)).not.toContain('voyage_fake_key');
  });

  test('an Env carrying connector-secret-shaped fields (slack, stripe) does not surface them', () => {
    const env = { CANVAS_USER: 'u', slack: 'xoxb-fake-token', stripe: 'sk_fake_key' } as never;
    const result = containerEnv(env, coords);
    expect(Object.values(result)).not.toContain('xoxb-fake-token');
    expect(Object.values(result)).not.toContain('sk_fake_key');
  });
});
