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
  // The fake env below carries the R2 creds ALONGSIDE realistic dangerous values
  // (Claude OAuth token, Turso/auth secrets, the GitHub App private key, VAPID private
  // key) — every one of them present with a real-looking string, not undefined. A
  // `toEqual` against an object that merely omits the dangerous keys would still pass
  // if a regression forwarded them as `undefined` (`toEqual` ignores undefined-valued
  // properties), which is exactly the leak this test exists to catch. Asserting on
  // `Object.keys` makes an extra key fail regardless of its value.
  const leakyEnv = {
    R2_BUCKET: 'agent-canvas',
    R2_ACCESS_KEY_ID: 'ak_123',
    R2_SECRET_ACCESS_KEY: 'sk_456',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake',
    TURSO_URL: 'libsql://prod.turso.io',
    TURSO_KEY: 'turso_fake_key',
    BETTER_AUTH_SECRET: 'better_auth_fake_secret',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----fake-----END RSA PRIVATE KEY-----',
    VAPID_PRIVATE_KEY: 'vapid_fake_private_key',
  } as never;

  test('forwards the four R2 S3 creds', () => {
    const result = warehouseContainerEnv(leakyEnv);
    expect(result.R2_BUCKET).toBe('agent-canvas');
    expect(result.R2_ACCESS_KEY_ID).toBe('ak_123');
    expect(result.R2_SECRET_ACCESS_KEY).toBe('sk_456');
    expect(result.R2_ENDPOINT).toBe('https://example.r2.cloudflarestorage.com');
  });

  test('never forwards the Claude OAuth token, Turso/auth secrets, or private keys', () => {
    expect(Object.keys(warehouseContainerEnv(leakyEnv)).sort()).toEqual(
      ['R2_ACCESS_KEY_ID', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_SECRET_ACCESS_KEY'].sort()
    );
  });
});
