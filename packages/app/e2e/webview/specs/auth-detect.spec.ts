/**
 * WebView e2e: auth-mode detection branches.
 *
 * cedarpad's launch flow asks the sidecar `auth.detect` before deciding
 * whether to render the AuthPrompt. Three modes:
 *   - `subscription` — Claude Code OAuth login is active. No prompt.
 *   - `api-key`      — BYOK key in the keychain. No prompt.
 *   - `none`         — neither path. Prompt rendered, subscription path
 *                      surfaced first, BYOK toggle below it.
 *
 * Subscription detection depends on the host's `~/.claude/.credentials.json`,
 * which we cannot reliably control inside CI / dev machines. The harness
 * sets `CEDARPAD_E2E_AUTH_MODE` (empty string at launch) which gates a
 * test-only `auth.setE2EOverride` channel; this spec calls that channel
 * to flip the forced mode per case and reloads the renderer to re-probe.
 */
import { browser, $ } from '@wdio/globals'

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>
}

type ForcedMode = 'subscription' | 'api-key' | 'none' | null

async function setOverrideAndReload(mode: ForcedMode): Promise<void> {
  await browser.executeAsync<void, [ForcedMode]>((m, done) => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    if (!tauri?.invoke) {
      done()
      return
    }
    tauri
      .invoke('rpc', { method: 'auth.setE2EOverride', params: { mode: m } })
      .then(() => {
        window.location.reload()
        done()
      })
      .catch(() => done())
  }, mode)
}

async function waitForPrompt(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const el = await $('[data-testid="auth-prompt"]')
      return el.isExisting()
    },
    { timeout: 10000, timeoutMsg: 'AuthPrompt did not render' },
  )
}

async function waitForTree(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const el = await $('.tree-node .content')
      return el.isExisting()
    },
    { timeout: 15000, timeoutMsg: 'Tree did not render' },
  )
}

describe('webview e2e: auth.detect modes', () => {
  it('subscription mode: no AuthPrompt, Tree renders directly', async () => {
    await browser.url('tauri://localhost')
    await setOverrideAndReload('subscription')
    await waitForTree()

    const prompt = await $('[data-testid="auth-prompt"]')
    if (await prompt.isExisting()) {
      throw new Error('AuthPrompt was visible in subscription mode')
    }
  })

  it('api-key mode: no AuthPrompt, Tree renders directly', async () => {
    await browser.url('tauri://localhost')
    await setOverrideAndReload('api-key')
    await waitForTree()

    const prompt = await $('[data-testid="auth-prompt"]')
    if (await prompt.isExisting()) {
      throw new Error('AuthPrompt was visible in api-key mode')
    }
  })

  it('none mode: AuthPrompt shows with subscription path on top, BYOK toggle below', async () => {
    await browser.url('tauri://localhost')
    await setOverrideAndReload('none')
    await waitForPrompt()

    // Subscription guidance present.
    const subSection = await $('.auth-subscription')
    if (!(await subSection.isExisting())) {
      throw new Error('subscription section not rendered')
    }
    const subText = await subSection.getText()
    if (!/claude \/login/i.test(subText)) {
      throw new Error(`subscription section missing 'claude /login' instruction; got: ${subText}`)
    }

    // BYOK toggle present, BYOK form initially hidden.
    const toggle = await $('[data-testid="auth-show-api-key"]')
    if (!(await toggle.isExisting())) {
      throw new Error('BYOK toggle not rendered')
    }
    const inputBefore = await $('[data-testid="api-key-input"]')
    if (await inputBefore.isExisting()) {
      throw new Error('BYOK input was visible before toggle click — should be collapsed by default')
    }

    // Click toggle — BYOK form expands.
    await browser.execute(() => {
      const btn = document.querySelector(
        '[data-testid="auth-show-api-key"]',
      ) as HTMLButtonElement | null
      btn?.click()
    })
    await browser.pause(80)
    const inputAfter = await $('[data-testid="api-key-input"]')
    if (!(await inputAfter.isExisting())) {
      throw new Error('BYOK input did not appear after toggle click')
    }

    // Tree must NOT be visible while the prompt is up.
    const tree = await $('.tree-node .content')
    if (await tree.isExisting()) {
      throw new Error('Tree was visible while AuthPrompt was up')
    }
  })

  // Reset the override so subsequent specs in the run start from a clean
  // state (the override is shared across the wdio session because the
  // sidecar is reused).
  after(async () => {
    await browser.executeAsync<void, []>((done) => {
      const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
      if (!tauri?.invoke) {
        done()
        return
      }
      tauri
        .invoke('rpc', { method: 'auth.setE2EOverride', params: { mode: null } })
        .then(() => done())
        .catch(() => done())
    })
  })
})
