/**
 * WebView e2e: three nested nodes survive a relaunch through the rendered
 * Tauri WebView.
 *
 * This is the harness-validation test for slice 1. It exercises the same
 * persistence path the IPC-level `e2e/tests/persistence.spec.ts` covers,
 * but goes through real keystrokes hitting the real React keymap inside
 * the real WKWebView. Coverage isn't the point — proving the harness
 * works end-to-end is.
 *
 * Setup is driven by `wdio.conf.ts`:
 *   - A worktree-scoped tmp dir is created, recents store is pre-seeded
 *     with a fresh repo, and `tauri-webdriver` is spawned with
 *     `CEDARPAD_GLOBAL_DIR` pointing at that store. Each WebDriver session
 *     spawns the binary fresh, which auto-restores the seeded workspace
 *     via the existing recents code path.
 */
import { browser, $, $$ } from '@wdio/globals'

async function focusedContent(): Promise<HTMLElement | null> {
  return browser.execute(() => document.activeElement as HTMLElement | null)
}

async function visibleContents(): Promise<string[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node .content')) as HTMLElement[]
    return nodes.map((n) => (n.textContent ?? '').trim())
  })
}

interface VisibleRow {
  content: string
  depth: number
}

async function visibleRows(): Promise<VisibleRow[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
    return nodes.map((n) => {
      const padding = parseInt(n.style.paddingLeft || '0', 10)
      const depth = Math.round(padding / 18) // Tree.tsx: paddingLeft: depth * 18
      const content = (n.querySelector('.content')?.textContent ?? '').trim()
      return { content, depth }
    })
  })
}

async function waitForBoot(): Promise<void> {
  // App.tsx renders "Loading…" until booted, then either WorkspacePicker or
  // toolbar+Tree. Recents seed → toolbar+Tree path. We wait for the
  // contentEditable to appear, which means Tree mounted and the auto-seed
  // node was created.
  try {
    await browser.waitUntil(
      async () => {
        const found = await $$('.tree-node .content')
        return found.length > 0
      },
      { timeout: 15000, timeoutMsg: 'Tree never rendered — workspace probably not auto-restored' },
    )
  } catch (e) {
    const dump = await browser.execute(() => ({
      isTauri: !!(window as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }).__TAURI__ || !!(window as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
      url: window.location.href,
      bodyText: document.body.textContent,
      html: document.body.innerHTML.slice(0, 800),
    }))
    // eslint-disable-next-line no-console
    console.error('[boot-fail dump]', JSON.stringify(dump, null, 2))
    throw e
  }
}

async function focusFirstNode(): Promise<void> {
  // Tree gives focus to the auto-created empty root node, but reload may
  // have lost it. Click the first content cell to be sure.
  const first = await $('.tree-node .content')
  await first.click()
}

const SPECIAL_KEY = {
  Enter: '',
  Tab: '',
} as const

/**
 * Type a single printable character into the focused contentEditable.
 *
 * Mac WebKit's WebDriver delivers keydown/keyup correctly but does NOT
 * trigger the browser's native "insert text" action for contentEditable
 * — so plain `browser.keys('A')` produces keyboard events but the cell's
 * `textContent` never changes and React's `onInput` never fires. This is
 * inherent to how the W3C key synthesis is wired through WKWebView.
 *
 * Workaround: drive the React `onInput` path directly via the same
 * native `input` event the browser would dispatch on real text entry.
 * The Tree's update IPC, render, and persistence all run normally — we
 * only bypass the OS-level text insertion step.
 */
async function typeChar(ch: string): Promise<void> {
  await browser.execute((c: string) => {
    const el = document.activeElement as HTMLElement | null
    if (!el || !el.isContentEditable) throw new Error('no contentEditable focused')
    el.textContent = (el.textContent ?? '') + c
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }))
  }, ch)
  // Tree's onInput fires `outline.update` fire-and-forget. Pause long
  // enough that a subsequent Enter (which triggers load() and re-renders
  // from the DB) sees our typed character persisted.
  await browser.pause(200)
}

/**
 * Send a non-printable key (Enter/Tab) via the W3C Actions API. These DO
 * deliver to the focused element's keydown handler, which is what the
 * React keymap interpreter listens to — so this is "real keystrokes
 * hitting the real React keymap" exactly as the user would.
 */
async function typeKey(name: keyof typeof SPECIAL_KEY): Promise<void> {
  const code = SPECIAL_KEY[name]
  await browser.action('key').down(code).up(code).perform()
  await browser.pause(180)
}

describe('webview e2e: nested nodes survive relaunch', () => {
  it('types A → Enter → B → Tab → C, relaunches, sees them all', async () => {
    // ----- run 1: type three nodes -----
    // tauri-plugin-webdriver opens the session on about:blank; we navigate
    // to the app's actual entry URL.
    await browser.url('tauri://localhost')
    await waitForBoot()
    await focusFirstNode()

    // Sanity check: the focused element is a contentEditable cell.
    const initialFocus = await browser.execute(() => ({
      tag: document.activeElement?.tagName,
      cls: document.activeElement?.className,
      contentEditable: (document.activeElement as HTMLElement | null)?.isContentEditable,
    }))
    if (!initialFocus.contentEditable) {
      throw new Error(`expected contentEditable focus, got ${JSON.stringify(initialFocus)}`)
    }

    // Drive the keymap to produce three nested nodes: A → B → C.
    //
    //   A             type A in the auto-created root cell
    //   Enter         create a sibling at root level (empty)
    //   Tab           nest the new (empty) cell under A → A has child ""
    //   B             type B into that nested cell → A → B
    //   Enter         create a sibling of B (under A, empty)
    //   Tab           nest that empty cell under B → A → B → ""
    //   C             type C → A → B → C
    //
    // Letters use a JS-injected `input` event because WebKit's WebDriver
    // doesn't trigger native text insertion against contentEditable;
    // Enter/Tab use the W3C Actions API and hit React's keydown handler.
    await typeChar('A')
    await typeKey('Enter')
    await typeKey('Tab')
    await typeChar('B')
    await typeKey('Enter')
    await typeKey('Tab')
    await typeChar('C')
    // Give the IPC chain time to flush updates + re-render.
    await browser.pause(1000)

    const before = await visibleRows()
    assertNestedABC(before, 'pre-restart')

    // ----- relaunch: end the current session and start a new one. This
    // re-launches the cedarpad binary fresh; the seeded recents store is
    // unchanged on disk so the app auto-restores the same workspace.
    await browser.reloadSession()
    await browser.url('tauri://localhost')
    await waitForBoot()

    const after = await visibleRows()
    assertNestedABC(after, 'post-restart')
  })
})

function assertNestedABC(rows: VisibleRow[], phase: string): void {
  const expected = [
    { content: 'A', depth: 0 },
    { content: 'B', depth: 1 },
    { content: 'C', depth: 2 },
  ]
  const actual = rows.filter((r) => r.content !== '') // ignore empty trailing nodes
  if (actual.length !== expected.length) {
    throw new Error(`${phase}: expected 3 non-empty rows, got ${actual.length}: ${JSON.stringify(rows)}`)
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!
    const got = actual[i]!
    if (got.content !== exp.content || got.depth !== exp.depth) {
      throw new Error(`${phase}: row ${i} expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)} (full: ${JSON.stringify(rows)})`)
    }
  }
}
