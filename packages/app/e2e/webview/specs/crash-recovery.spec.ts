/**
 * WebView e2e (slice 4): crash recovery.
 *
 * The acceptance criterion: if the app crashes mid-turn, on next launch
 * the partial Turn must be marked `interrupted` (visually distinct from
 * `cancelled`).
 *
 * Scenario:
 *   1. Create a Thread Root and an orphan streaming Turn (a Turn Node
 *      with `metadata.state = 'streaming'`). We construct it directly via
 *      a renderer test hook rather than killing the sidecar mid-real-
 *      stream — the SCAN logic is the production code under test, and
 *      from its point of view "an orphan streaming Turn on disk" is the
 *      input regardless of how it got there. (The unit test
 *      `modules/thread/crashRecovery.test.ts` already covers the engine
 *      side; this spec verifies the renderer surfaces the recovered
 *      `interrupted` state.)
 *   2. Run `thread.scanInterrupted` (the same call App.tsx fires on
 *      launch).
 *   3. Reload the tree and assert the Turn now carries
 *      `data-turn-state="interrupted"` — the visual treatment that
 *      tells the user this was a crash, not a deliberate cancel.
 */
import { browser, $$ } from '@wdio/globals'

interface VisualRow {
  visual: string
  kind: string
  content: string
  depth: number
  nodeId: string
  turnState?: string
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
        turnState: n.dataset.turnState,
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

interface SetupResult {
  threadRootId: string
  workspaceId: string
}

async function createThreadRoot(content: string): Promise<SetupResult> {
  return browser.executeAsync<SetupResult, [string]>((c, done) => {
    const tauri = (
      window as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__
    const hook = (
      window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } }
    ).cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done({ threadRootId: '', workspaceId: '' })
      return
    }
    let workspaceId = ''
    tauri
      .invoke('rpc', { method: 'workspace.recent', params: {} })
      .then((r) => {
        const list = r as Array<{ id: string }>
        if (list.length === 0) throw new Error('no recent workspaces')
        workspaceId = list[0]!.id
        return tauri.invoke!('rpc', {
          method: 'outline.create',
          params: { workspaceId, parentId: null, content: c },
        })
      })
      .then((node) =>
        tauri.invoke!('rpc', {
          method: 'thread.start',
          params: { workspaceId, rootNodeId: (node as { id: string }).id },
        }).then(() => node),
      )
      .then((node) =>
        hook
          .reload()
          .then(() => done({ threadRootId: (node as { id: string }).id, workspaceId })),
      )
      .catch(() => done({ threadRootId: '', workspaceId: '' }))
  }, content)
}

async function createOrphanStreamingTurn(threadRootId: string): Promise<string> {
  return browser.executeAsync<string, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: { createOrphanStreamingTurn: (threadRootId: string) => Promise<string> }
      }
    ).cedarpadE2E
    if (!hook?.createOrphanStreamingTurn) {
      done('')
      return
    }
    hook
      .createOrphanStreamingTurn(id)
      .then((turnId) => done(turnId))
      .catch(() => done(''))
  }, threadRootId)
}

interface ScanResult {
  interruptedTurnIds: string[]
}

async function runScan(): Promise<ScanResult> {
  return browser.executeAsync<ScanResult, []>((done) => {
    const hook = (
      window as unknown as { cedarpadE2E?: { scanInterrupted: () => Promise<ScanResult> } }
    ).cedarpadE2E
    if (!hook?.scanInterrupted) {
      done({ interruptedTurnIds: [] })
      return
    }
    hook
      .scanInterrupted()
      .then((r) => done(r))
      .catch(() => done({ interruptedTurnIds: [] }))
  })
}

async function deleteNode(workspaceId: string, id: string): Promise<void> {
  await browser.executeAsync<void, [string, string]>((wsId, nodeId, done) => {
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
      .invoke('rpc', { method: 'outline.delete', params: { workspaceId: wsId, id: nodeId } })
      .then(() => hook.reload().then(() => done()))
      .catch(() => done())
  }, workspaceId, id)
}

describe('webview e2e (slice 4): crash recovery', () => {
  it('marks orphan streaming Turn as interrupted after scan', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom in case a prior spec left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { threadRootId, workspaceId } = await createThreadRoot(
      'cedarpad slice4 crash-recovery spec',
    )
    if (!threadRootId) throw new Error('createThreadRoot failed')

    try {
      const turnId = await createOrphanStreamingTurn(threadRootId)
      if (!turnId) throw new Error('createOrphanStreamingTurn failed')

      // Sanity: before the scan, the Turn renders as `streaming`.
      const before = await rows()
      const turnBefore = before.find((r) => r.nodeId === turnId)
      if (!turnBefore || turnBefore.turnState !== 'streaming') {
        throw new Error(
          `expected the orphan turn to render as streaming pre-scan; got ${JSON.stringify(turnBefore)}`,
        )
      }

      const scan = await runScan()
      if (!scan.interruptedTurnIds.includes(turnId)) {
        throw new Error(
          `scan did not report our turn as interrupted; got ${JSON.stringify(scan)}`,
        )
      }

      // After the scan, the renderer reflects state=interrupted.
      const after = await rows()
      const turnAfter = after.find((r) => r.nodeId === turnId)
      if (!turnAfter) throw new Error('orphan turn vanished after scan')
      if (turnAfter.turnState !== 'interrupted') {
        throw new Error(
          `expected state=interrupted; got ${JSON.stringify(turnAfter)}`,
        )
      }
    } finally {
      if (threadRootId) await deleteNode(workspaceId, threadRootId)
    }
  })
})
