/**
 * WebView e2e (v1.1 Shape B): crash recovery.
 *
 * Acceptance criterion: if the app crashes mid-Prompt, on next launch
 * the partial Prompt must be marked `interrupted` (visually distinct
 * from `cancelled`).
 *
 * Scenario:
 *   1. Create a session-bearer Content Node and an orphan streaming
 *      Prompt (a Content Node with `metadata.state = 'streaming'`).
 *      We construct it directly via a renderer test hook rather than
 *      killing the sidecar mid-real-stream — the SCAN logic is the
 *      production code under test, and from its point of view "an
 *      orphan streaming Prompt on disk" is the input regardless of how
 *      it got there. (The unit test
 *      `modules/thread/crashRecovery.test.ts` already covers the
 *      engine side; this spec verifies the renderer surfaces the
 *      recovered `interrupted` state.)
 *   2. Run `thread.scanInterrupted` (the same call App.tsx fires on
 *      launch).
 *   3. Reload the tree and assert the Prompt now carries
 *      `data-prompt-state="interrupted"` — the visual treatment that
 *      tells the user this was a crash, not a deliberate cancel.
 */
import { browser, $$ } from '@wdio/globals'

interface VisualRow {
  visual: string
  kind: string
  content: string
  depth: number
  nodeId: string
  promptState?: string
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
        promptState: n.dataset.promptState,
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
  bearerId: string
  workspaceId: string
}

async function createBearer(content: string): Promise<SetupResult> {
  return browser.executeAsync<SetupResult, [string]>((c, done) => {
    const tauri = (
      window as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const hook = (window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } })
      .cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done({ bearerId: '', workspaceId: '' })
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
          params: {
            workspaceId,
            parentId: null,
            content: c,
            metadata: { sdkSessionId: null },
          },
        })
      })
      .then((node) =>
        hook
          .reload()
          .then(() => done({ bearerId: (node as { id: string }).id, workspaceId })),
      )
      .catch(() => done({ bearerId: '', workspaceId: '' }))
  }, content)
}

async function createOrphanStreamingPrompt(parentId: string): Promise<string> {
  return browser.executeAsync<string, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: { createOrphanStreamingPrompt: (parentId: string) => Promise<string> }
      }
    ).cedarpadE2E
    if (!hook?.createOrphanStreamingPrompt) {
      done('')
      return
    }
    hook
      .createOrphanStreamingPrompt(id)
      .then((promptId) => done(promptId))
      .catch(() => done(''))
  }, parentId)
}

interface ScanResult {
  interruptedPromptIds: string[]
}

async function runScan(): Promise<ScanResult> {
  return browser.executeAsync<ScanResult, []>((done) => {
    const hook = (
      window as unknown as { cedarpadE2E?: { scanInterrupted: () => Promise<ScanResult> } }
    ).cedarpadE2E
    if (!hook?.scanInterrupted) {
      done({ interruptedPromptIds: [] })
      return
    }
    hook
      .scanInterrupted()
      .then((r) => done(r))
      .catch(() => done({ interruptedPromptIds: [] }))
  })
}

async function deleteNode(workspaceId: string, id: string): Promise<void> {
  await browser.executeAsync<void, [string, string]>(
    (wsId, nodeId, done) => {
      const tauri = (
        window as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const hook = (window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } })
        .cedarpadE2E
      if (!tauri?.invoke || !hook) {
        done()
        return
      }
      tauri
        .invoke('rpc', { method: 'outline.delete', params: { workspaceId: wsId, id: nodeId } })
        .then(() => hook.reload().then(() => done()))
        .catch(() => done())
    },
    workspaceId,
    id,
  )
}

describe('webview e2e (v1.1 Shape B): crash recovery', () => {
  it('marks orphan streaming Prompt as interrupted after scan', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { bearerId, workspaceId } = await createBearer('cedarpad v1.1 crash-recovery spec')
    if (!bearerId) throw new Error('createBearer failed')

    try {
      const promptId = await createOrphanStreamingPrompt(bearerId)
      if (!promptId) throw new Error('createOrphanStreamingPrompt failed')

      // Sanity: before the scan, the Prompt renders as `streaming`.
      const before = await rows()
      const promptBefore = before.find((r) => r.nodeId === promptId)
      if (!promptBefore || promptBefore.promptState !== 'streaming') {
        throw new Error(
          `expected the orphan prompt to render as streaming pre-scan; got ${JSON.stringify(promptBefore)}`,
        )
      }

      const scan = await runScan()
      if (!scan.interruptedPromptIds.includes(promptId)) {
        throw new Error(
          `scan did not report our prompt as interrupted; got ${JSON.stringify(scan)}`,
        )
      }

      const after = await rows()
      const promptAfter = after.find((r) => r.nodeId === promptId)
      if (!promptAfter) throw new Error('orphan prompt vanished after scan')
      if (promptAfter.promptState !== 'interrupted') {
        throw new Error(`expected state=interrupted; got ${JSON.stringify(promptAfter)}`)
      }
    } finally {
      if (bearerId) await deleteNode(workspaceId, bearerId)
    }
  })
})
