import { describe, expect, test } from 'bun:test';

import { containerEnv, warehouseContainerEnv } from './container-env.ts';
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

// ADR-0017 gated-layer rule: the warehouse container writes parquet to R2, so it needs
// the R2 S3 creds — but nothing else. Unlike containerEnv (the chat/canvas container),
// this must NEVER carry an extraction secret (Slack/Stripe/Mercury) or the Claude OAuth
// token — the whole point of the second container class is that those simply aren't
// reachable from it, structurally, not by policy.
describe('warehouseContainerEnv — R2 creds only', () => {
  test('forwards the four R2 S3 creds', () => {
    const env = {
      R2_BUCKET: 'agent-canvas',
      R2_ACCESS_KEY_ID: 'ak_123',
      R2_SECRET_ACCESS_KEY: 'sk_456',
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    } as never;
    expect(warehouseContainerEnv(env)).toEqual({
      R2_BUCKET: 'agent-canvas',
      R2_ACCESS_KEY_ID: 'ak_123',
      R2_SECRET_ACCESS_KEY: 'sk_456',
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    });
  });
});
