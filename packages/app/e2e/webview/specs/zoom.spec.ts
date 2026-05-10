/**
 * WebView e2e for slice 7: Workflowy-style zoom-in + breadcrumbs + persistence.
 *
 * Flow:
 *   1. Build a three-level nested tree A → B → C (same shape as restart.spec).
 *   2. Focus B and zoom in via Cmd+. — only B and its descendants render,
 *      A is hidden, breadcrumb shows "<repo> / B".
 *   3. Click the workspace crumb to zoom out — A/B/C all visible again.
 *   4. Zoom in again, then end the WebDriver session and relaunch the
 *      binary. Verify the persisted zoom restores: only B and C visible,
 *      breadcrumb shows "<repo> / B".
 *
 * Same caveats as restart.spec.ts apply (printable chars are JS-injected,
 * non-printable keys go through the W3C Actions API).
 */
import { browser, $, $$ } from '@wdio/globals'

interface VisibleRow {
  content: string
  depth: number
}

interface Crumbs {
  /** Text of every breadcrumb button, in order, including the workspace root. */
  labels: string[]
  /** ID of the .crumb-current element, or null if none (= root view). */
  currentText: string | null
}

async function visibleRows(): Promise<VisibleRow[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
    return nodes.map((n) => {
      const padding = parseInt(n.style.paddingLeft || '0', 10)
      const depth = Math.round(padding / 18)
      const content = (n.querySelector('.content')?.textContent ?? '').trim()
      return { content, depth }
    })
  })
}

async function readCrumbs(): Promise<Crumbs> {
  return browser.execute(() => {
    const buttons = Array.from(document.querySelectorAll('.breadcrumbs .crumb')) as HTMLElement[]
    const labels = buttons.map((b) => (b.textContent ?? '').trim())
    const cur = document.querySelector('.breadcrumbs .crumb-current') as HTMLElement | null
    return { labels, currentText: cur ? (cur.textContent ?? '').trim() : null }
  })
}

async function waitForBoot(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await $$('.tree-node .content')
      return found.length > 0
    },
    { timeout: 15000, timeoutMsg: 'Tree never rendered — workspace probably not auto-restored' },
  )
}

async function focusFirstNode(): Promise<void> {
  const first = await $('.tree-node .content')
  await first.click()
}

/**
 * Move focus to the contentEditable cell whose textContent is `text`.
 * Throws if no such cell exists.
 */
async function focusNodeWithText(text: string): Promise<void> {
  const found = await browser.execute((needle: string) => {
    const cells = Array.from(document.querySelectorAll('.tree-node .content')) as HTMLElement[]
    const hit = cells.find((c) => (c.textContent ?? '').trim() === needle)
    if (!hit) return false
    hit.focus()
    return true
  }, text)
  if (!found) throw new Error(`could not find node with text="${text}"`)
}

const SPECIAL_KEY = {
  Enter: '',
  Tab: '',
} as const

async function typeChar(ch: string): Promise<void> {
  await browser.execute((c: string) => {
    const el = document.activeElement as HTMLElement | null
    if (!el || !el.isContentEditable) throw new Error('no contentEditable focused')
    el.textContent = (el.textContent ?? '') + c
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }))
  }, ch)
  await browser.pause(200)
}

async function typeKey(name: keyof typeof SPECIAL_KEY): Promise<void> {
  const code = SPECIAL_KEY[name]
  await browser.action('key').down(code).up(code).perform()
  await browser.pause(180)
}

/**
 * Synthesise Cmd/Ctrl+key directly via the React `keydown` handler. The
 * W3C Actions chord delivers keydown but we've seen it not always carry
 * the `metaKey` flag through WKWebView; firing the same KeyboardEvent the
 * keymap interpreter listens to is reliable and exercises the same code
 * path the user hits.
 */
async function pressMetaKey(key: string): Promise<void> {
  await browser.execute((k: string) => {
    const el = document.activeElement as HTMLElement | null
    const target = el && el.isContentEditable ? el : document.activeElement
    if (!target) throw new Error('no focused element to dispatch keydown to')
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, key)
  await browser.pause(250)
}

/**
 * Idempotent A/B/C builder. The wdio harness seeds a single workspace and
 * shares it across specs in the run, so this spec must tolerate the tree
 * already being populated by an earlier spec. We treat A → B → C as the
 * required precondition: if the current visible tree already matches, skip
 * building; otherwise type the keystrokes that would produce it.
 */
async function ensureABCTree(): Promise<void> {
  const cur = await visibleRows()
  const nonEmpty = cur.filter((r) => r.content !== '')
  const isAlreadyABC =
    nonEmpty.length === 3 &&
    nonEmpty[0]!.content === 'A' &&
    nonEmpty[0]!.depth === 0 &&
    nonEmpty[1]!.content === 'B' &&
    nonEmpty[1]!.depth === 1 &&
    nonEmpty[2]!.content === 'C' &&
    nonEmpty[2]!.depth === 2
  if (isAlreadyABC) return

  // No tree (or partial). Build from the auto-seeded empty root. We rely
  // on the auto-seed having created an empty cell to type into.
  await focusFirstNode()
  await typeChar('A')
  await typeKey('Enter')
  await typeKey('Tab')
  await typeChar('B')
  await typeKey('Enter')
  await typeKey('Tab')
  await typeChar('C')
  await browser.pause(800)

  const built = await visibleRows()
  const builtNonEmpty = built.filter((r) => r.content !== '')
  if (builtNonEmpty.length !== 3) {
    throw new Error(`expected A/B/C built, got ${JSON.stringify(built)}`)
  }
}

describe('webview e2e: zoom + breadcrumbs persist across relaunch', () => {
  it('zooms into B, breadcrumbs reflect path, persists across restart', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // The previous spec in the run may have left the current zoom pointing
    // at a node that no longer exists (or set up unrelated state). Reset
    // to the workspace root before we start so visibleRows() sees the
    // whole tree.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(400)

    await ensureABCTree()

    // ----- zoom into B -----
    await focusNodeWithText('B')
    await pressMetaKey('.')
    await browser.pause(500)

    const zoomed = await visibleRows()
    const zoomedNonEmpty = zoomed.filter((r) => r.content !== '')
    // Only C should be visible (B is the zoom root, hidden); depth 0 because
    // the subtree's root depth resets when zoomed.
    if (zoomedNonEmpty.length !== 1 || zoomedNonEmpty[0]!.content !== 'C') {
      throw new Error(`zoom-in: expected only C, got ${JSON.stringify(zoomed)}`)
    }

    const crumbs = await readCrumbs()
    if (crumbs.currentText !== 'B') {
      throw new Error(`zoom-in: expected current crumb=B, got ${JSON.stringify(crumbs)}`)
    }
    // The trail from workspace root → A → B should be reflected as three
    // crumbs: workspace, A, B (with B current).
    if (
      crumbs.labels.length !== 3 ||
      crumbs.labels[1] !== 'A' ||
      crumbs.labels[2] !== 'B'
    ) {
      throw new Error(`zoom-in: expected crumbs [<repo>, A, B], got ${JSON.stringify(crumbs)}`)
    }

    // ----- zoom out via breadcrumb click on the workspace root -----
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (!root) throw new Error('no .crumb-root')
      root.click()
    })
    await browser.pause(500)

    const back = await visibleRows()
    const backNonEmpty = back.filter((r) => r.content !== '')
    if (backNonEmpty.length !== 3) {
      throw new Error(`zoom-out: expected A/B/C back, got ${JSON.stringify(back)}`)
    }

    // ----- zoom in again, then relaunch and verify persistence -----
    await focusNodeWithText('B')
    await pressMetaKey('.')
    await browser.pause(500)

    await browser.reloadSession()
    await browser.url('tauri://localhost')
    await waitForBoot()

    const after = await visibleRows()
    const afterNonEmpty = after.filter((r) => r.content !== '')
    if (afterNonEmpty.length !== 1 || afterNonEmpty[0]!.content !== 'C') {
      throw new Error(`post-restart: expected only C visible, got ${JSON.stringify(after)}`)
    }
    const afterCrumbs = await readCrumbs()
    if (afterCrumbs.currentText !== 'B') {
      throw new Error(
        `post-restart: expected current crumb=B, got ${JSON.stringify(afterCrumbs)}`,
      )
    }
  })
})
