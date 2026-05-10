/**
 * WebView e2e: search palette finds a node and navigates to it.
 *
 * The harness seeds a single workspace shared by all specs in the run, and
 * `restart.spec.ts` leaves behind a nested tree (A depth 0 → B depth 1 →
 * C depth 2). We rely on that tree being present rather than building our
 * own — typing Enter/Tab into already-populated cells is finicky in
 * WebKit's WebDriver, and reusing the seeded fixture keeps this test
 * focused on the search affordance itself.
 *
 * Flow:
 *   1. Open the search palette via Cmd+K (a global keydown listener in
 *      App.tsx — we dispatch a synthetic KeyboardEvent because WebKit's
 *      WebDriver actions API can't deliver modifier+letter chords into a
 *      contentEditable-bearing window reliably; the same constraint
 *      drove the typeChar workaround in restart.spec.ts).
 *   2. Type a query that matches a known seeded node, wait for results.
 *   3. Verify the result row shows ancestor path context.
 *   4. Press Enter, assert the corresponding tree cell is focused.
 */
import { browser, $, $$ } from '@wdio/globals'

async function waitForBoot(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await $$('.tree-node .content')
      return found.length > 0
    },
    { timeout: 15000, timeoutMsg: 'Tree never rendered — workspace probably not auto-restored' },
  )
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
      const depth = Math.round(padding / 18)
      const content = (n.querySelector('.content')?.textContent ?? '').trim()
      return { content, depth }
    })
  })
}

/**
 * Insert a printable character into the focused input via a native input
 * event. WebKit's WebDriver doesn't trigger native text insertion on
 * contentEditable; the same trick works for inputs and is consistent with
 * `typeChar` in restart.spec.ts.
 */
async function typeChar(ch: string): Promise<void> {
  await browser.execute((c: string) => {
    const el = document.activeElement as HTMLElement | null
    if (!el) throw new Error('no element focused')
    if (el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) throw new Error('no value setter')
      setter.call(el, (el.value ?? '') + c)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    if (el.isContentEditable) {
      el.textContent = (el.textContent ?? '') + c
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }))
      return
    }
    throw new Error(`focused element ${el.tagName} is not editable`)
  }, ch)
  await browser.pause(120)
}

/**
 * Dispatch a Cmd-modified keystroke at `window` so App.tsx's keydown
 * listener fires. This bypasses both the WebDriver Actions API (modifier
 * chords are flaky in WKWebView) and the OS-level menu/shortcut hand-off
 * (we only need React to see the event).
 */
async function sendCmdKey(letter: string): Promise<void> {
  await browser.execute((k: string) => {
    const ev = new KeyboardEvent('keydown', {
      key: k,
      metaKey: true,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(ev)
  }, letter)
  await browser.pause(150)
}

async function fireWindowKey(key: string): Promise<void> {
  await browser.execute((k: string) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
  }, key)
  await browser.pause(200)
}

describe('webview e2e: search palette navigation', () => {
  it('opens via Cmd+K, finds a seeded node, Enter navigates to it', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Confirm the seeded A→B→C tree is present (left over from
    // restart.spec.ts's run earlier in this suite). If that spec is
    // skipped or the tree is otherwise empty, this test relies on at
    // least one persisted node we can search for.
    const rows = await visibleRows()
    const target = rows.find((r) => r.content === 'C')
    if (!target) {
      throw new Error(
        `pre-search: expected a 'C' row in seeded tree, got ${JSON.stringify(rows)}`,
      )
    }
    if (target.depth < 2) {
      throw new Error(
        `pre-search: expected 'C' to be nested under at least one ancestor, got depth ${target.depth}`,
      )
    }

    // Open the search palette.
    await sendCmdKey('k')
    await browser.waitUntil(
      async () => {
        const input = await $('.search-input')
        return input.isExisting()
      },
      { timeout: 3000, timeoutMsg: 'search palette did not open' },
    )

    // The palette autofocuses on mount, but our synthetic Cmd+K bypasses
    // the focus side-effects that real keyboards trigger. Click the
    // input directly to ensure the focused element is the search field
    // before we start typing.
    const input = await $('.search-input')
    await input.click()

    // Type the query. Single-char tokens match under FTS5's default
    // unicode61 tokenizer; "C" hits the deeply-nested cell.
    await typeChar('C')

    // Wait for at least one result.
    await browser.waitUntil(
      async () => {
        const items = await browser.execute(() => {
          return Array.from(document.querySelectorAll('.switcher-item'))
            .filter((r) => r.getAttribute('data-result-id') != null)
            .map((r) => ({
              text: (r.querySelector('div')?.textContent ?? '').trim(),
              path: (r.querySelector('.path')?.textContent ?? '').trim(),
            }))
        })
        return items.length > 0
      },
      { timeout: 3000, timeoutMsg: 'search returned no results' },
    )

    const items = await browser.execute(() => {
      return Array.from(document.querySelectorAll('.switcher-item'))
        .filter((r) => r.getAttribute('data-result-id') != null)
        .map((r) => ({
          id: r.getAttribute('data-result-id'),
          text: (r.querySelector('div')?.textContent ?? '').trim(),
          path: (r.querySelector('.path')?.textContent ?? '').trim(),
          isSelected: r.classList.contains('selected'),
        }))
    })

    const hit = items.find((i) => i.text === 'C')
    if (!hit) {
      throw new Error(`expected 'C' in results, got ${JSON.stringify(items)}`)
    }
    // Acceptance: each result shows a brief ancestor path. C is nested
    // under A → B, so the path should mention 'B' (the immediate parent).
    if (!hit.path.includes('B')) {
      throw new Error(`expected ancestor path to include 'B', got ${JSON.stringify(hit)}`)
    }

    // The first result should be selected by default (selected=0 on each
    // new query). If 'C' isn't first, walk down to it with ArrowDown.
    let cursor = items.findIndex((i) => i.isSelected)
    if (cursor < 0) cursor = 0
    const targetIdx = items.findIndex((i) => i.text === 'C')
    while (cursor < targetIdx) {
      await fireWindowKey('ArrowDown')
      cursor++
    }

    // Press Enter to navigate.
    await fireWindowKey('Enter')

    // Palette should close; tree cell for 'C' should be focused.
    await browser.waitUntil(
      async () => {
        const stillOpen = await browser.execute(
          () => document.querySelector('.search-input') != null,
        )
        return !stillOpen
      },
      { timeout: 3000, timeoutMsg: 'search palette did not close on Enter' },
    )

    const focused = await browser.execute(() => {
      const a = document.activeElement as HTMLElement | null
      if (!a) return null
      return {
        tag: a.tagName,
        contentEditable: a.isContentEditable,
        text: (a.textContent ?? '').trim(),
        cls: a.className,
      }
    })
    if (!focused || !focused.contentEditable) {
      throw new Error(`expected focused contentEditable after navigation, got ${JSON.stringify(focused)}`)
    }
    if (focused.text !== 'C') {
      throw new Error(`expected focused cell to be 'C', got ${JSON.stringify(focused)}`)
    }
  })
})
