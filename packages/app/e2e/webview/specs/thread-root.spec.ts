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
 * Hygiene: this spec creates a *dedicated* Content Node via IPC (not by
 * typing into whatever node the previous spec left lying around) and
 * deletes it at the end of the test, so it does not pollute state for
 * the zoom / search specs that may run after it. The wdio harness
 * shares one seeded recents DB across specs.
 *
 * macOS WebKit's WebDriver caveats from restart.spec.ts apply here too:
 * native text insertion against contentEditable is unreliable, and
 * synthesised modifier+letter chords are flaky. We use a JS-dispatched
 * KeyboardEvent for the Cmd+Shift+T chord, which is what React's
 * `onKeyDown` listens to anyway, and IPC for setup/teardown.
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

/**
 * Create a fresh top-level Content Node via the renderer's IPC and return
 * its id. Reloads the Tree's view so the new row appears in the DOM, and
 * focuses its content cell so the Cmd+Shift+T keymap fires against it.
 */
async function createIsolatedContentNode(content: string): Promise<string> {
  const id = await browser.executeAsync<string, [string]>((c, done) => {
    const tauri = (
      window as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__
    const hook = (
      window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } }
    ).cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done('' as unknown as string)
      return
    }
    tauri
      .invoke('rpc', { method: 'workspace.recent', params: {} })
      .then((r) => {
        const list = r as Array<{ id: string }>
        if (list.length === 0) throw new Error('no recent workspaces')
        return tauri.invoke!('rpc', {
          method: 'outline.create',
          params: { workspaceId: list[0]!.id, parentId: null, content: c },
        })
      })
      .then((node) => hook.reload().then(() => done((node as { id: string }).id as unknown as string)))
      .catch(() => done('' as unknown as string))
  }, content)
  return id
}

async function deleteNode(id: string): Promise<void> {
  await browser.executeAsync<void, [string]>((nodeId, done) => {
    const tauri = (
      window as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__
    const hook = (
      window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } }
    ).cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done()
      return
    }
    tauri
      .invoke('rpc', { method: 'workspace.recent', params: {} })
      .then((r) => {
        const list = r as Array<{ id: string }>
        if (list.length === 0) throw new Error('no recent workspaces')
        return tauri.invoke!('rpc', {
          method: 'outline.delete',
          params: { workspaceId: list[0]!.id, id: nodeId },
        })
      })
      .then(() => hook.reload().then(() => done()))
      .catch(() => done())
  }, id)
}

async function focusNodeById(id: string): Promise<void> {
  // Click the .content cell whose .tree-node ancestor has data-node-id=id.
  await browser.execute((nodeId: string) => {
    const row = document.querySelector(`.tree-node[data-node-id="${nodeId}"]`) as HTMLElement | null
    const cell = row?.querySelector('.content') as HTMLElement | null
    if (!cell) throw new Error(`no .content cell for node ${nodeId}`)
    cell.focus()
    cell.click()
  }, id)
  await browser.pause(80)
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

    // Reset zoom — a previous spec may have left the workspace zoomed into
    // a node that no longer has the ones we're about to look up.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(300)

    // Create an isolated Content Node specifically for this spec — the
    // workspace already contains rows from earlier specs (restart, search)
    // and we'd rather not entangle with them.
    const nodeId = await createIsolatedContentNode('cedarpad slice2 thread spec')
    if (!nodeId) throw new Error('could not create isolated content node via IPC')

    try {
      // Promote with Cmd+Shift+T while the node is focused.
      await focusNodeById(nodeId)
      await pressCmdShiftT()

      let snapshot = await rows()
      const threadRootRow = snapshot.find((r) => r.nodeId === nodeId && r.visual === 'thread-root')
      if (!threadRootRow) {
        throw new Error(
          `expected a thread-root visual on node ${nodeId}; got ${JSON.stringify(snapshot)}`,
        )
      }

      // Inject a fixture Turn under the Thread Root.
      await injectFixtureTurn(nodeId)
      snapshot = await rows()

      // The Turn + 3 Block children belong specifically to our Thread Root.
      // Filter the snapshot to rows below this Thread Root's depth that
      // appear after it in the visible-flat order — that's its subtree.
      const idx = snapshot.findIndex((r) => r.nodeId === nodeId)
      if (idx < 0) throw new Error('thread-root row vanished after appendTurn')
      const trDepth = snapshot[idx]!.depth
      const subtree: VisualRow[] = []
      for (let i = idx + 1; i < snapshot.length; i++) {
        if (snapshot[i]!.depth <= trDepth) break
        subtree.push(snapshot[i]!)
      }

      const visuals = subtree.map((r) => r.visual)
      if (!visuals.includes('turn')) {
        throw new Error(`turn visual missing in subtree: ${JSON.stringify(subtree)}`)
      }
      if (!visuals.includes('block-text')) {
        throw new Error(`block-text visual missing: ${JSON.stringify(subtree)}`)
      }
      if (!visuals.includes('block-tool-use')) {
        throw new Error(`block-tool-use visual missing: ${JSON.stringify(subtree)}`)
      }
      if (!visuals.includes('block-tool-result')) {
        throw new Error(`block-tool-result visual missing: ${JSON.stringify(subtree)}`)
      }

      const blocks = subtree.filter((r) => r.kind === 'block')
      if (blocks.length !== 3) {
        throw new Error(`expected 3 block rows; got ${blocks.length}: ${JSON.stringify(blocks)}`)
      }
      for (const b of blocks) {
        if (b.depth <= trDepth) {
          throw new Error(`block at unexpected depth: ${JSON.stringify(b)}`)
        }
      }
    } finally {
      // Clean up: deleting the Thread Root cascades to the Turn + Blocks
      // (FK ON DELETE CASCADE on nodes.parent_id), so subsequent specs
      // see no leftover state from this one.
      await deleteNode(nodeId)
    }
  })
})
