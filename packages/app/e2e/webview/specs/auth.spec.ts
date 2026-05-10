/**
 * WebView e2e (slice 3): first-launch BYOK flow.
 *
 * The harness pre-populates the in-memory keychain with a default key (so
 * the previously-shipped specs don't have to type one on every fresh
 * binary launch). This spec deliberately deletes the default, reloads
 * the page, asserts the ApiKeyPrompt renders, types a fake key, submits,
 * and asserts the workspace surface (Tree) becomes available afterward.
 *
 * Slice 3 acceptance criterion: "App refuses to start a Thread without a
 * key configured." The Tree (and therefore the Cmd+Shift+T → start a
 * Thread keymap) is not reachable while the prompt is up.
 *
 * Cleanup: writes a default-style key back at the end so any spec that
 * runs after this one in the same session inherits the expected state.
 */
import { browser, $ } from '@wdio/globals'

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>
}

async function deleteApiKeyAndReload(): Promise<void> {
  await browser.executeAsync<void, []>((done) => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    if (!tauri?.invoke) {
      done()
      return
    }
    tauri
      .invoke('auth_delete_api_key')
      .then(() => {
        // Reload the page so App.tsx re-probes hasApiKey.
        window.location.reload()
        done()
      })
      .catch(() => done())
  })
}

async function waitForPrompt(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const el = await $('[data-testid="auth-prompt"]')
      return el.isExisting()
    },
    { timeout: 10000, timeoutMsg: 'ApiKeyPrompt did not render after key deletion' },
  )
}

async function waitForTree(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await $('.tree-node .content')
      return found.isExisting()
    },
    { timeout: 15000, timeoutMsg: 'Tree did not render after saving key' },
  )
}

describe('webview e2e (slice 3): BYOK first-launch flow', () => {
  it('refuses to start without a key, accepts one, then surfaces the Tree', async () => {
    await browser.url('tauri://localhost')
    // Wait for boot first; whether we land on Tree or prompt depends on
    // the seed default key which the harness installs.
    await browser.waitUntil(
      async () => {
        const tree = await $('.tree-node .content')
        const prompt = await $('[data-testid="auth-prompt"]')
        return (await tree.isExisting()) || (await prompt.isExisting())
      },
      { timeout: 15000, timeoutMsg: 'App never finished booting' },
    )

    // Force the prompt path: delete the seeded default and reload.
    await deleteApiKeyAndReload()
    await waitForPrompt()

    // Tree must NOT be visible while the prompt is up.
    const treeWhilePrompt = await $('.tree-node .content')
    if (await treeWhilePrompt.isExisting()) {
      throw new Error('Tree was visible while the API key prompt was up — refuse-without-key invariant broken')
    }

    // The new AuthPrompt hides the BYOK form behind a "Use an API key
    // instead" toggle (subscription is the primary path). Click the
    // toggle so the existing input/submit testids are in the DOM.
    await browser.execute(() => {
      const btn = document.querySelector(
        '[data-testid="auth-show-api-key"]',
      ) as HTMLButtonElement | null
      if (!btn) throw new Error('no auth-show-api-key toggle')
      btn.click()
    })
    await browser.pause(80)

    // Inject a key directly via the React-controlled input. Mac WebView's
    // text-insertion quirk applies here too: dispatch an `InputEvent` so
    // React's onChange fires.
    await browser.execute(() => {
      const input = document.querySelector('[data-testid="api-key-input"]') as HTMLInputElement | null
      if (!input) throw new Error('no input')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(input, 'sk-ant-fake-from-spec')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await browser.pause(80)

    await browser.execute(() => {
      const btn = document.querySelector('[data-testid="api-key-submit"]') as HTMLButtonElement | null
      if (!btn) throw new Error('no submit button')
      btn.click()
    })

    await waitForTree()

    // Sanity: the Tauri command-side reports the key is present.
    const has = await browser.executeAsync<boolean, []>((done) => {
      const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
      if (!tauri?.invoke) {
        done(false)
        return
      }
      tauri
        .invoke('auth_has_api_key')
        .then((v) => done(Boolean(v)))
        .catch(() => done(false))
    })
    if (!has) throw new Error('auth_has_api_key returned false after save')
  })
})
