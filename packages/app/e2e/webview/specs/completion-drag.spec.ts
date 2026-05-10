/**
 * WebView e2e: completion + drag-reorder survive a relaunch.
 *
 * Slice 9 acceptance: keyboard toggles `completed`, workspace toggle hides
 * completed Nodes, drag-reorder works within and across parents, and all
 * three states persist across relaunch.
 *
 * WebKit's WebDriver caveats (documented at length in restart.spec.ts):
 *   - Printable keys don't trigger native text insertion against
 *     contentEditable, so we drive the React `onInput` path with an
 *     injected `InputEvent`.
 *   - Non-printable keys (Enter, Tab) DO route through keydown handlers,
 *     so we use the W3C Actions API for those.
 *   - Native HTML5 drag-and-drop is not reliably synthesised by
 *     WebDriver. We dispatch real `DragEvent`s with a `DataTransfer`
 *     directly to the React handlers — same code path the browser would
 *     hit on a real drop. The renderer's onDragStart/onDragOver/onDrop
 *     handlers run, the IPC fires, and persistence happens identically.
 */
import { browser, $, $$ } from '@wdio/globals'

interface VisibleRow {
  content: string
  depth: number
  completed: boolean
  hidden: boolean
}

async function visibleRows(): Promise<VisibleRow[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
    return nodes.map((n) => {
      const padding = parseInt(n.style.paddingLeft || '0', 10)
      const depth = Math.round(padding / 18)
      const content = (n.querySelector('.content')?.textContent ?? '').trim()
      const completed = n.classList.contains('completed')
      // The Tree never renders hidden rows in the DOM when hideCompleted is on
      // — instead it skips them at the visible-list level. So `hidden` here
      // is always false; included for forward compat.
      const hidden = n.style.display === 'none'
      return { content, depth, completed, hidden }
    })
  })
}

async function waitForBoot(): Promise<void> {
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
  const first = await $('.tree-node .content')
  await first.click()
}

async function focusNodeByContent(text: string): Promise<void> {
  await browser.execute((needle: string) => {
    const cells = Array.from(document.querySelectorAll('.tree-node .content')) as HTMLElement[]
    const found = cells.find((c) => (c.textContent ?? '').trim() === needle)
    if (!found) throw new Error(`no .content cell with text "${needle}"`)
    found.focus()
    const range = document.createRange()
    range.selectNodeContents(found)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, text)
}

async function typeChar(ch: string): Promise<void> {
  await browser.execute((c: string) => {
    const el = document.activeElement as HTMLElement | null
    if (!el || !el.isContentEditable) throw new Error('no contentEditable focused')
    el.textContent = (el.textContent ?? '') + c
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }))
  }, ch)
  await browser.pause(180)
}

const SPECIAL_KEY = {
  Enter: '',
  Tab: '',
} as const

async function typeKey(name: keyof typeof SPECIAL_KEY): Promise<void> {
  const code = SPECIAL_KEY[name]
  await browser.action('key').down(code).up(code).perform()
  await browser.pause(180)
}

/**
 * Toggle completion via Cmd+Enter dispatched synthetically. We can't rely
 * on the W3C Actions chord because Mac WebKit's WebDriver doesn't always
 * report metaKey on synthesised Enter events; dispatching the
 * KeyboardEvent directly hits the same React keydown handler path.
 */
async function pressCmdEnter(): Promise<void> {
  await browser.execute(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) throw new Error('nothing focused')
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await browser.pause(220)
}

async function pressShiftTab(): Promise<void> {
  await browser.execute(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) throw new Error('nothing focused')
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        code: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await browser.pause(220)
}

/**
 * Synthesise a drag from one node row to another. We dispatch the same
 * sequence the browser would: dragstart on source → dragover on target
 * (with clientY positioned to land in the desired third) → drop on target.
 * The Tree's React handlers consume these directly.
 */
async function dragNode(
  fromText: string,
  toText: string,
  zone: 'before' | 'after' | 'inside',
): Promise<void> {
  await browser.execute(
    (from: string, to: string, dropZone: 'before' | 'after' | 'inside') => {
      const rows = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
      const findRow = (txt: string): HTMLElement => {
        const r = rows.find((row) => (row.querySelector('.content')?.textContent ?? '').trim() === txt)
        if (!r) throw new Error(`no .tree-node with content "${txt}"`)
        return r
      }
      const src = findRow(from)
      const dst = findRow(to)
      const dt = new DataTransfer()
      const dstRect = dst.getBoundingClientRect()
      let clientY: number
      if (dropZone === 'before') clientY = dstRect.top + 2
      else if (dropZone === 'after') clientY = dstRect.bottom - 2
      else clientY = dstRect.top + dstRect.height / 2
      const clientX = dstRect.left + 10

      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      dst.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX,
          clientY,
        }),
      )
      dst.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX,
          clientY,
        }),
      )
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    fromText,
    toText,
    zone,
  )
  // outline.move + load() round-trip.
  await browser.pause(500)
}

async function clickHideCompletedToggle(): Promise<void> {
  const btn = await $('[data-testid="toggle-hide-completed"]')
  await btn.click()
  await browser.pause(150)
}

describe('webview e2e: completion + drag-reorder', () => {
  it('marks complete, hides completed, reorders within parent, moves across parents, persists across relaunch', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()
    await focusFirstNode()

    // Build the seed outline:
    //   A
    //     A.1
    //   B
    //
    // Keystroke recipe:
    //   A          → first cell becomes "A"
    //   Enter      → new sibling at root (empty)
    //   Tab        → nest under A → A.1 cell
    //   A.1        → typing into nested cell
    //   Enter      → sibling of A.1 (empty, depth 1)
    //   Shift+Tab  → outdent that cell back to root → after A
    //   B          → root sibling
    await typeChar('A')
    await typeKey('Enter')
    await typeKey('Tab')
    await typeChar('A')
    await typeChar('.')
    await typeChar('1')
    await typeKey('Enter')
    // Shift+Tab outdent (synthesised — mirrors how pressCmdEnter is wired).
    await pressShiftTab()
    await typeChar('B')
    await browser.pause(800)

    const seeded = (await visibleRows()).filter((r) => r.content !== '')
    if (
      seeded.length !== 3 ||
      seeded[0]!.content !== 'A' ||
      seeded[1]!.content !== 'A.1' ||
      seeded[2]!.content !== 'B'
    ) {
      throw new Error(`seed outline wrong: ${JSON.stringify(seeded)}`)
    }

    // ----- complete A.1 via Cmd+Enter -----
    await focusNodeByContent('A.1')
    await pressCmdEnter()
    let rows = await visibleRows()
    const a1Row = rows.find((r) => r.content === 'A.1')
    if (!a1Row || !a1Row.completed) {
      throw new Error(`A.1 should be completed, got ${JSON.stringify(rows)}`)
    }

    // ----- toggle hide-completed -----
    await clickHideCompletedToggle()
    rows = await visibleRows()
    if (rows.some((r) => r.content === 'A.1')) {
      throw new Error(`A.1 should be hidden when hideCompleted is on: ${JSON.stringify(rows)}`)
    }
    // Toggle back so we can drag visible rows.
    await clickHideCompletedToggle()
    rows = await visibleRows()
    if (!rows.some((r) => r.content === 'A.1')) {
      throw new Error(`A.1 should reappear when hideCompleted is off: ${JSON.stringify(rows)}`)
    }

    // ----- drag B before A (reorder within root) -----
    await dragNode('B', 'A', 'before')
    rows = (await visibleRows()).filter((r) => r.content !== '')
    // Order should now be B, A, A.1 (A.1 still child of A, still completed).
    if (rows[0]?.content !== 'B' || rows[1]?.content !== 'A' || rows[2]?.content !== 'A.1') {
      throw new Error(`after reorder, expected [B,A,A.1], got ${JSON.stringify(rows)}`)
    }

    // ----- drag A.1 inside B (move across parents, descendants travel) -----
    // First add a child to A.1 so we can verify descendants travel.
    await focusNodeByContent('A.1')
    await typeKey('Enter')
    await typeKey('Tab')
    await typeChar('A')
    await typeChar('.')
    await typeChar('1')
    await typeChar('.')
    await typeChar('1')
    await browser.pause(400)
    rows = (await visibleRows()).filter((r) => r.content !== '')
    if (!rows.some((r) => r.content === 'A.1.1' && r.depth === 2)) {
      throw new Error(`expected A.1.1 nested under A.1, got ${JSON.stringify(rows)}`)
    }

    // Drag A.1 inside B → A.1 (and A.1.1) become children of B.
    await dragNode('A.1', 'B', 'inside')
    rows = (await visibleRows()).filter((r) => r.content !== '')
    // Expected: B, B's children A.1 → A.1.1, then A.
    const labels = rows.map((r) => `${r.content}@${r.depth}`)
    const aIdx = labels.indexOf('A@0')
    const bIdx = labels.indexOf('B@0')
    const a1Idx = labels.indexOf('A.1@1')
    const a11Idx = labels.indexOf('A.1.1@2')
    if (bIdx < 0 || aIdx < 0 || a1Idx < 0 || a11Idx < 0) {
      throw new Error(`after cross-parent move, missing rows: ${JSON.stringify(rows)}`)
    }
    if (!(bIdx < a1Idx && a1Idx < a11Idx)) {
      throw new Error(`A.1.1 should follow A.1 under B: ${JSON.stringify(rows)}`)
    }

    // ----- relaunch and verify all state persists -----
    await browser.reloadSession()
    await browser.url('tauri://localhost')
    await waitForBoot()

    const after = (await visibleRows()).filter((r) => r.content !== '')
    const afterLabels = after.map((r) => `${r.content}@${r.depth}`)
    if (afterLabels.indexOf('B@0') < 0 || afterLabels.indexOf('A.1@1') < 0 || afterLabels.indexOf('A.1.1@2') < 0) {
      throw new Error(`post-restart shape lost: ${JSON.stringify(after)}`)
    }
    const a1AfterRestart = after.find((r) => r.content === 'A.1')
    if (!a1AfterRestart?.completed) {
      throw new Error(`A.1 completion lost across restart: ${JSON.stringify(after)}`)
    }

    // hide-completed preference is persisted per-workspace in localStorage,
    // which Tauri's WKWebView preserves across launches for the same app
    // origin. We left it OFF before restart, so verify A.1 is still
    // visible (covered above). Toggle ON post-restart and verify hide
    // still works after a fresh boot.
    await clickHideCompletedToggle()
    const finalRows = await visibleRows()
    if (finalRows.some((r) => r.content === 'A.1')) {
      throw new Error(`A.1 should be hidden post-restart toggle: ${JSON.stringify(finalRows)}`)
    }
  })
})
