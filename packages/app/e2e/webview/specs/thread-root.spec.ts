/**
 * WebView e2e (slice 2): a Content Node can be promoted to a Thread Root
 * via Cmd+Shift+T, and a fixture-injected turn renders as a Turn Node
 * with three visually-distinct Block children (text / tool_use / tool_result).
 *
 * No real Claude here — slice 2 only owns the tree-side Thread engine and
 * its UI. The fixture turn is driven via the dev-time test hook
 * `window.cedarpadE2E.appendTurn`, which forwards to thread.appendTurn IPC
 * through the same handler the SDK runner will use in slice 3.
 *
 * macOS WebKit's WebDriver caveats from restart.spec.ts apply here too:
 * native text insertion against contentEditable is unreliable, and
 * synthesised modifier+letter chords are flaky. We use:
 *   - typeChar (JS-injected InputEvent) for printable characters,
 *   - the W3C Actions API (`Enter` / `Tab`) for plain non-printables, and
 *   - a JS-dispatched KeyboardEvent for the Cmd+Shift+T chord, which is
 *     what React's `onKeyDown` listens to anyway.
 */
import { browser, $, $$ } from '@wdio/globals'

interface VisualRow {
  visual: string
  kind: string
  content: string
  depth: number
  nodeId: string
}

async function rows(): Promise<VisualRow[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
    return nodes.map((n) => {
      const padding = parseInt(n.style.paddingLeft || '0', 10)
      return {
        visual: n.dataset.visual ?? 'unknown',
        kind: n.dataset.kind ?? 'unknown',
        content: (n.querySelector('.content')?.textContent ?? '').trim(),
        depth: Math.round(padding / 18),
        nodeId: n.dataset.nodeId ?? '',
      }
    })
  })
}

async function waitForBoot(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await $$('.tree-node .content')
      return found.length > 0
    },
    { timeout: 15000, timeoutMsg: 'Tree never rendered' },
  )
}

async function focusFirstNode(): Promise<void> {
  const first = await $('.tree-node .content')
  await first.click()
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

async function pressCmdShiftT(): Promise<void> {
  // Synthesise a Cmd+Shift+T keydown on the focused element. React's
  // onKeyDown listens to native keydown; a dispatched KeyboardEvent with
  // bubbles:true reaches the React listener attached at the document root
  // via React's synthetic event delegation.
  await browser.execute(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) throw new Error('no focused element')
    const evt = new KeyboardEvent('keydown', {
      key: 't',
      code: 'KeyT',
      shiftKey: true,
      metaKey: true,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    })
    el.dispatchEvent(evt)
  })
  // thread.start IPC + reload + re-render
  await browser.pause(500)
}

async function injectFixtureTurn(threadRootId: string): Promise<void> {
  await browser.executeAsync((id: string, done: (v?: unknown) => void) => {
    const hook = (window as unknown as {
      cedarpadE2E?: {
        appendTurn: (
          threadRootId: string,
          blocks: unknown[],
        ) => Promise<void>
      }
    }).cedarpadE2E
    if (!hook) {
      done({ error: 'cedarpadE2E hook not exposed' })
      return
    }
    hook
      .appendTurn(id, [
        { kind: 'text', text: 'Looking at README' },
        { kind: 'tool_use', toolName: 'Read', toolUseId: 'tu_1', input: { path: 'README.md' } },
        { kind: 'tool_result', toolUseId: 'tu_1', output: 'cedarpad outliner' },
      ])
      .then(() => done({ ok: true }))
      .catch((e) => done({ error: String(e) }))
  }, threadRootId)
  await browser.pause(300)
}

describe('webview e2e (slice 2): Thread Root + fixture turn', () => {
  it('promotes a Content Node to a Thread Root, then renders a fixture turn', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()
    await focusFirstNode()

    // Type some text into the auto-seeded root Content Node.
    await typeChar('I')
    await typeChar('d')
    await typeChar('e')
    await typeChar('a')
    await browser.pause(200)

    // Promote with Cmd+Shift+T → Thread Root.
    await pressCmdShiftT()

    let snapshot = await rows()
    const threadRootRow = snapshot.find((r) => r.visual === 'thread-root')
    if (!threadRootRow) {
      throw new Error(`expected a thread-root visual; got ${JSON.stringify(snapshot)}`)
    }
    // Content tolerance: wdio runs specs serially against the same seeded
    // recents DB, so the previous restart spec may have left rows behind.
    // We only require that our typed text landed *somewhere* on the
    // promoted node — exact equality would be flaky.
    if (!threadRootRow.content.includes('Idea')) {
      throw new Error(`thread-root content missing 'Idea': ${JSON.stringify(threadRootRow)}`)
    }

    // Inject a fixture Turn under the Thread Root. Read its id off the
    // rendered DOM (data-node-id is set by Tree.tsx).
    if (!threadRootRow.nodeId) {
      throw new Error('thread-root row missing data-node-id')
    }
    await injectFixtureTurn(threadRootRow.nodeId)

    snapshot = await rows()

    const visuals = snapshot.map((r) => r.visual)
    if (!visuals.includes('thread-root')) {
      throw new Error(`thread-root missing post-turn: ${JSON.stringify(snapshot)}`)
    }
    if (!visuals.includes('turn')) {
      throw new Error(`turn visual missing: ${JSON.stringify(snapshot)}`)
    }
    if (!visuals.includes('block-text')) {
      throw new Error(`block-text visual missing: ${JSON.stringify(snapshot)}`)
    }
    if (!visuals.includes('block-tool-use')) {
      throw new Error(`block-tool-use visual missing: ${JSON.stringify(snapshot)}`)
    }
    if (!visuals.includes('block-tool-result')) {
      throw new Error(`block-tool-result visual missing: ${JSON.stringify(snapshot)}`)
    }

    // Block kinds must all be 'block' (i.e. the schema-level kind), and
    // each must be a child (depth > thread root depth).
    const trDepth = snapshot.find((r) => r.visual === 'thread-root')!.depth
    const blocks = snapshot.filter((r) => r.kind === 'block')
    if (blocks.length !== 3) {
      throw new Error(`expected 3 block rows; got ${blocks.length}: ${JSON.stringify(blocks)}`)
    }
    for (const b of blocks) {
      if (b.depth <= trDepth) {
        throw new Error(`block at unexpected depth: ${JSON.stringify(b)}`)
      }
    }
  })
})
