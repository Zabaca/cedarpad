/**
 * WebView e2e: completion + drag-reorder survive a relaunch.
 *
 * Slice 9 acceptance: keyboard toggles `completed`, workspace toggle hides
 * completed Nodes, drag-reorder works within and across parents, and all
 * three states persist across relaunch.
 *
 * Seed strategy: this spec calls the Tauri RPC bridge
 * (`window.__TAURI_INTERNALS__.invoke('rpc', ...)`) directly to build the
 * outline, instead of typing through real keystrokes. The
 * keyboard-driven path is already covered by `restart.spec.ts`; here we
 * want a deterministic seed so the assertions for completion + drag are
 * about THOSE features, not about whether the W3C key actions API is
 * cooperating with WKWebView on this run.
 *
 * WebKit/WebDriver caveats relevant to this spec:
 *   - Cmd+Enter (toggle complete) dispatches a synthetic KeyboardEvent
 *     because Mac WebKit's WebDriver doesn't reliably propagate
 *     modifier state on chorded W3C Actions key sequences. The
 *     KeyboardEvent bubbles into React's delegated keydown listener
 *     and hits the keymap interpreter exactly as a real keypress would.
 *   - Native HTML5 drag-and-drop is not reliably synthesised by
 *     WebDriver. We dispatch real `DragEvent`s with a `DataTransfer`
 *     directly to the React handlers — same code path the browser
 *     would hit on a real drop. The renderer's
 *     onDragStart/onDragOver/onDrop run, the IPC fires, and persistence
 *     happens identically.
 */
import { browser, $, $$ } from '@wdio/globals'

interface VisibleRow {
  content: string
  depth: number
  completed: boolean
}

async function visibleRows(): Promise<VisibleRow[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
    return nodes.map((n) => {
      const padding = parseInt(n.style.paddingLeft || '0', 10)
      const depth = Math.round(padding / 18)
      const content = (n.querySelector('.content')?.textContent ?? '').trim()
      const completed = n.classList.contains('completed')
      return { content, depth, completed }
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

interface SeededIds {
  workspaceId: string
  a: string
  a1: string
  b: string
}

/**
 * Seed via the Tauri IPC bridge. The auto-created empty root node from
 * Tree.tsx is removed so we have a clean shape: A, A.1 (child of A), B.
 * Returns ids so subsequent assertions can target nodes by id, not by
 * fragile DOM-text lookup.
 */
async function seedOutlineViaIpc(): Promise<SeededIds> {
  return browser.executeAsync(async (done: (ids: SeededIds) => void) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    if (!internals?.invoke) {
      done({ workspaceId: '', a: '', a1: '', b: '' })
      return
    }
    const invoke = internals.invoke.bind(internals)
    const rpc = async <T,>(method: string, params: unknown): Promise<T> => {
      return (await invoke('rpc', { method, params })) as T
    }
    const active = (await rpc<{ id: string } | null>('workspace.active', {}))!
    const workspaceId = active.id

    // Wipe any existing nodes so the spec is hermetic across re-runs.
    const roots = await rpc<{ id: string }[]>('outline.getChildren', {
      workspaceId,
      parentId: null,
    })
    for (const r of roots) {
      await rpc('outline.delete', { workspaceId, id: r.id })
    }

    const a = (await rpc<{ id: string }>('outline.create', {
      workspaceId,
      parentId: null,
      content: 'A',
    })).id
    const a1 = (await rpc<{ id: string }>('outline.create', {
      workspaceId,
      parentId: a,
      content: 'A.1',
    })).id
    const b = (await rpc<{ id: string }>('outline.create', {
      workspaceId,
      parentId: null,
      prevSiblingId: a,
      content: 'B',
    })).id
    done({ workspaceId, a, a1, b })
  })
}

async function reloadTree(): Promise<void> {
  // Tree.tsx loads on mount + on workspaceId change. The simplest way to
  // force a re-render after IPC mutations is a full page reload — Tauri
  // restores the workspace from recents on next mount. We use
  // `location.reload()` directly because `browser.url(sameUrl)` is a
  // no-op on WebKit when the document is already at that URL.
  await browser.execute(() => {
    window.location.reload()
  })
  // Give the page a moment to start tearing down before we wait for the
  // new mount.
  await browser.pause(300)
  await waitForBoot()
}

/**
 * v1.1: Cmd+Enter is the sole conversation-starting verb (ADR-0006), so
 * it no longer toggles completion. The completion-toggle UX gesture is
 * now click-the-bullet (or a future shortcut not yet bound). For this
 * spec the gesture is incidental — we want to verify completion +
 * hide-completed + drag-reorder, not the binding. Drive `outline.update`
 * directly via IPC to flip `completed: true` on the focused node.
 */
async function toggleCompleteByContent(text: string): Promise<void> {
  await browser.executeAsync(async (needle: string, done: () => void) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const hook = (window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } })
      .cedarpadE2E
    if (!internals?.invoke || !hook) {
      done()
      return
    }
    const invoke = internals.invoke.bind(internals)
    const active = (await invoke('rpc', { method: 'workspace.active', params: {} })) as {
      id: string
    } | null
    if (!active) {
      done()
      return
    }
    // Find the node id by walking children-of-children for matching content.
    const queue: (string | null)[] = [null]
    let foundId: string | null = null
    while (queue.length && !foundId) {
      const parent = queue.shift()!
      const kids = (await invoke('rpc', {
        method: 'outline.getChildren',
        params: { workspaceId: active.id, parentId: parent },
      })) as { id: string; content: string }[]
      for (const k of kids) {
        if (k.content === needle) {
          foundId = k.id
          break
        }
        queue.push(k.id)
      }
    }
    if (!foundId) {
      done()
      return
    }
    await invoke('rpc', {
      method: 'outline.update',
      params: { workspaceId: active.id, id: foundId, completed: true },
    })
    await hook.reload()
    done()
  }, text)
  await browser.pause(150)
}

/**
 * Synthesise a drag from one row to another. We dispatch the same
 * sequence the browser would: dragstart on source → dragover on target
 * (with clientY positioned to land in the desired third) → drop on
 * target. The Tree's React handlers consume these directly.
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

/**
 * Wipe all nodes from the active workspace via IPC. Restores the
 * workspace to "empty" state, after which Tree.tsx's auto-seed effect
 * will create one fresh empty root cell on next mount — exactly the
 * shape `restart.spec.ts` expects. We run this in `after` so this spec
 * doesn't pollute the DB for the next spec sharing the same harness.
 */
async function wipeWorkspace(): Promise<void> {
  await browser.executeAsync(async (done: () => void) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    if (!internals?.invoke) {
      done()
      return
    }
    const invoke = internals.invoke.bind(internals)
    const active = (await invoke('rpc', { method: 'workspace.active', params: {} })) as { id: string } | null
    if (!active) {
      done()
      return
    }
    const roots = (await invoke('rpc', {
      method: 'outline.getChildren',
      params: { workspaceId: active.id, parentId: null },
    })) as { id: string }[]
    for (const r of roots) {
      await invoke('rpc', {
        method: 'outline.delete',
        params: { workspaceId: active.id, id: r.id },
      })
    }
    // Also clear the per-workspace hide-completed pref so the next spec
    // starts with the default OFF.
    try {
      window.localStorage.removeItem(`cedarpad.hideCompleted.${active.id}`)
    } catch {
      // ignore
    }
    done()
  })
}

describe('webview e2e: completion + drag-reorder', () => {
  after(async () => {
    // Re-establish a session because the test reloads it; otherwise
    // browser.executeAsync would race against a torn-down session.
    try {
      await browser.url('tauri://localhost')
      await waitForBoot()
      await wipeWorkspace()
    } catch {
      // Best-effort cleanup; don't mask test failures with cleanup errors.
    }
  })

  it('marks complete, hides completed, reorders within parent, moves across parents, persists across relaunch', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // ----- seed via IPC, then reload so React mirrors the seeded shape -----
    const ids = await seedOutlineViaIpc()
    if (!ids.workspaceId) throw new Error('no Tauri internals — IPC seed failed')
    await reloadTree()

    let rows = (await visibleRows()).filter((r) => r.content !== '')
    if (
      rows.length !== 3 ||
      rows[0]!.content !== 'A' ||
      rows[1]!.content !== 'A.1' ||
      rows[2]!.content !== 'B'
    ) {
      throw new Error(`seed outline wrong: ${JSON.stringify(rows)}`)
    }

    // ----- complete A.1 via IPC (v1.1: Cmd+Enter is now send-prompt; see
    // ADR-0006). The completion behaviour itself is what this spec
    // exercises, not the keybinding.
    await toggleCompleteByContent('A.1')
    rows = await visibleRows()
    const a1Row = rows.find((r) => r.content === 'A.1')
    if (!a1Row || !a1Row.completed) {
      throw new Error(`A.1 should be completed, got ${JSON.stringify(rows)}`)
    }

    // ----- toggle hide-completed off→on→off -----
    await clickHideCompletedToggle()
    rows = await visibleRows()
    if (rows.some((r) => r.content === 'A.1')) {
      throw new Error(`A.1 should be hidden when hideCompleted is on: ${JSON.stringify(rows)}`)
    }
    await clickHideCompletedToggle()
    rows = await visibleRows()
    if (!rows.some((r) => r.content === 'A.1')) {
      throw new Error(`A.1 should reappear when hideCompleted is off: ${JSON.stringify(rows)}`)
    }

    // ----- drag B before A (reorder within root) -----
    await dragNode('B', 'A', 'before')
    rows = (await visibleRows()).filter((r) => r.content !== '')
    if (rows[0]?.content !== 'B' || rows[1]?.content !== 'A' || rows[2]?.content !== 'A.1') {
      throw new Error(`after reorder, expected [B,A,A.1], got ${JSON.stringify(rows)}`)
    }

    // ----- add A.1.1 under A.1 via IPC, then drag A.1 inside B -----
    await browser.executeAsync(async (workspaceId: string, a1Id: string, done: () => void) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
      await internals.invoke('rpc', {
        method: 'outline.create',
        params: { workspaceId, parentId: a1Id, content: 'A.1.1' },
      })
      done()
    }, ids.workspaceId, ids.a1)
    await reloadTree()
    rows = (await visibleRows()).filter((r) => r.content !== '')
    if (!rows.some((r) => r.content === 'A.1.1' && r.depth === 2)) {
      throw new Error(`expected A.1.1 nested under A.1, got ${JSON.stringify(rows)}`)
    }

    await dragNode('A.1', 'B', 'inside')
    rows = (await visibleRows()).filter((r) => r.content !== '')
    const labels = rows.map((r) => `${r.content}@${r.depth}`)
    if (
      labels.indexOf('B@0') < 0 ||
      labels.indexOf('A@0') < 0 ||
      labels.indexOf('A.1@1') < 0 ||
      labels.indexOf('A.1.1@2') < 0
    ) {
      throw new Error(`after cross-parent move, missing rows: ${JSON.stringify(rows)}`)
    }
    const bIdx = labels.indexOf('B@0')
    const a1Idx = labels.indexOf('A.1@1')
    const a11Idx = labels.indexOf('A.1.1@2')
    if (!(bIdx < a1Idx && a1Idx < a11Idx)) {
      throw new Error(`A.1.1 should follow A.1 under B: ${JSON.stringify(rows)}`)
    }

    // ----- relaunch and verify all state persists -----
    await browser.reloadSession()
    await browser.url('tauri://localhost')
    await waitForBoot()

    const after = (await visibleRows()).filter((r) => r.content !== '')
    const afterLabels = after.map((r) => `${r.content}@${r.depth}`)
    if (
      afterLabels.indexOf('B@0') < 0 ||
      afterLabels.indexOf('A.1@1') < 0 ||
      afterLabels.indexOf('A.1.1@2') < 0
    ) {
      throw new Error(`post-restart shape lost: ${JSON.stringify(after)}`)
    }
    const a1AfterRestart = after.find((r) => r.content === 'A.1')
    if (!a1AfterRestart?.completed) {
      throw new Error(`A.1 completion lost across restart: ${JSON.stringify(after)}`)
    }

    // hide-completed preference: toggle ON after restart and verify it
    // still works against the restored DB.
    await clickHideCompletedToggle()
    const finalRows = await visibleRows()
    if (finalRows.some((r) => r.content === 'A.1')) {
      throw new Error(`A.1 should be hidden post-restart toggle: ${JSON.stringify(finalRows)}`)
    }
  })
})
