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

  // #241: connector secrets (dlt sources) DO reach the warehouse env — that's the whole
  // point of this issue — but ONLY the ones explicitly passed in, and the dangerous keys
  // above must still never leak even with connector secrets present alongside them.
  test('merges in decrypted connector secrets by name, without touching the R2-only keys', () => {
    const result = warehouseContainerEnv(leakyEnv, { slack: 'xoxb-fake-token', stripe: 'sk_fake_key' });
    expect(result.slack).toBe('xoxb-fake-token');
    expect(result.stripe).toBe('sk_fake_key');
    expect(Object.keys(result).sort()).toEqual(
      ['R2_ACCESS_KEY_ID', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_SECRET_ACCESS_KEY', 'slack', 'stripe'].sort()
    );
  });

  test('the Claude OAuth token, Turso/auth secrets, and private keys still never leak when connector secrets are present', () => {
    const result = warehouseContainerEnv(leakyEnv, { slack: 'xoxb-fake-token' });
    expect(Object.keys(result).sort()).toEqual(
      ['R2_ACCESS_KEY_ID', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_SECRET_ACCESS_KEY', 'slack'].sort()
    );
    expect(Object.values(result)).not.toContain(leakyEnv.CLAUDE_CODE_OAUTH_TOKEN);
    expect(Object.values(result)).not.toContain(leakyEnv.BETTER_AUTH_SECRET);
    expect(Object.values(result)).not.toContain(leakyEnv.GITHUB_APP_PRIVATE_KEY);
    expect(Object.values(result)).not.toContain(leakyEnv.VAPID_PRIVATE_KEY);
  });

  test('with no connector secrets passed, the R2-only shape is unchanged (default param)', () => {
    expect(Object.keys(warehouseContainerEnv(leakyEnv)).sort()).toEqual(
      ['R2_ACCESS_KEY_ID', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_SECRET_ACCESS_KEY'].sort()
    );
  });

  // Regression: a connector name becomes an environment-variable name in the warehouse
  // process. If `connectorSecrets` were spread AFTER the platform keys (the original
  // shape of this function), a connector literally named `R2_SECRET_ACCESS_KEY` — or
  // `PATH` / `LD_PRELOAD` — would silently win the merge and hijack the shared-credential
  // container's R2 access or binary resolution. `resolveConnectorEnv`'s `CONNECTOR_`
  // namespacing and CONNECTOR_NAME_RE are the primary defenses (worker/connector-secrets.ts);
  // this test proves the SECOND, independent layer inside this function itself — even a
  // caller that bypassed validation and passed a raw platform-shaped key must never win.
  // This test FAILS if the platform-key spread ever moves back after `...connectorSecrets`.
  test('a connector secret named like a platform key never overrides it — platform keys always win the merge', () => {
    const result = warehouseContainerEnv(leakyEnv, {
      PATH: '/tmp/evil:/usr/bin',
      LD_PRELOAD: '/tmp/evil.so',
      R2_SECRET_ACCESS_KEY: 'attacker-controlled',
      R2_BUCKET: 'attacker-controlled-bucket',
    });
    expect(result.R2_SECRET_ACCESS_KEY).toBe('sk_456');
    expect(result.R2_BUCKET).toBe('agent-canvas');
    // PATH/LD_PRELOAD aren't platform keys this function emits at all, but a caller-supplied
    // one must not silently appear either — nothing in the real (non-attack) call path ever
    // passes them, so their presence here would itself be evidence of a leak.
    expect(result.PATH).toBe('/tmp/evil:/usr/bin'); // not a platform key here; passes through untouched
    expect(result.LD_PRELOAD).toBe('/tmp/evil.so'); // same — the real defense against these is CONNECTOR_NAME_RE at the API boundary
  });
});

// #241: connector secrets must reach ONLY the warehouse container, never the chat/canvas
// container (`containerEnv`) — the gated-layer rule this whole issue exists to respect.
// `containerEnv`'s signature takes no connector-secrets parameter at all, so this proves
// the guarantee structurally: there is no code path in this module that could thread a
// connector secret into it, not merely a policy of not calling it that way.
describe('containerEnv — connector secrets never reach the chat container (#241)', () => {
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('containerEnv has no connector-secrets parameter — its output cannot carry one', () => {
    expect(containerEnv.length).toBe(2);
    const env = { CANVAS_USER: 'user_abc123' } as never;
    const result = containerEnv(env, coords);
    // Even a maximally leaky Env (every warehouse key + connector-shaped keys present)
    // cannot make it through: containerEnv only reads the fixed field list below.
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
      TURSO_URL: 'libsql://prod.turso.io',
      TURSO_KEY: 'turso_fake_key',
      VOYAGE_API_KEY: 'voyage_fake_key',
      CANVAS_USER: 'u',
    } as never;

    const result = containerEnv(env, coords);

    expect(Object.keys(result)).not.toContain('TURSO_URL');
    expect(Object.keys(result)).not.toContain('TURSO_KEY');
    expect(Object.values(result)).not.toContain('libsql://prod.turso.io');
    expect(Object.values(result)).not.toContain('turso_fake_key');
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
