import { expect, test } from '../fixtures/test.ts';

/**
 * Harness smoke: proves the worktree-safe e2e round-trip works end to end —
 * the wrappers derived a port + dev DB, Playwright's webServer launched the
 * canvas dev stack (vite + bun bridge) on that port, and the app shell renders.
 *
 * It deliberately does NOT authenticate. The app is gated by Better Auth +
 * cs_gate; the fuller Shell flow (sign in → create/switch workspace → open
 * canvas → sign-out) is deferred to a follow-up spec behind the E2E_MODE shim
 * (see .claude/skills/worktree/SKILL.md). This smoke's job is to prove green
 * infrastructure, not product behavior.
 */
test('canvas dev stack boots and serves the app on the derived port', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.ok()).toBeTruthy();

  // index.html <title> — confirms vite served our app, not a proxy error page.
  await expect(page).toHaveTitle(/Agent Canvas/i);

  // The React mount point exists in the served HTML.
  await expect(page.locator('#root')).toBeAttached();
});
