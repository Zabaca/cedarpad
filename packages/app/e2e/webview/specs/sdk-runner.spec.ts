/**
 * WebView e2e (slice 3): SDK runner end-to-end against the deterministic
 * fake SDK.
 *
 * The harness sets `CEDARPAD_E2E_FAKE_SDK=1` in `wdio.conf.ts`, which
 * makes `chooseSdkClient()` return the deterministic stub from
 * `src-sidecar/src/sdkClient.ts`. The fake emits a fixed sequence
 * (text → tool_use → tool_result → text) regardless of the prompt, so
 * the spec can assert exact Block Node visuals without making a network
 * call or needing a real Anthropic key.
 *
 * Flow:
 *   1. Wait for boot (Tree visible).
 *   2. Create an isolated Content Node via IPC, promote it to a Thread
 *      Root by calling thread.start.
 *   3. Drive `window.cedarpadE2E.sendPrompt(threadRootId, prompt, repo)`
 *      — this exercises the streamSendPrompt path: rpc_stream Tauri
 *      command → sidecar → SDK runner → stream frames → renderer event
 *      listener.
 *   4. Assert the events fired in order (block-completes for each block,
 *      a final turn-complete) and that the corresponding Block Nodes
 *      appear under the Turn in the rendered tree.
 *   5. Clean up: delete the Thread Root (cascades to Turn + Blocks).
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

interface CreateAndPromoteResult {
  threadRootId: string
  workspaceId: string
  repoPath: string
}

async function createAndPromote(content: string): Promise<CreateAndPromoteResult> {
  return browser.executeAsync<CreateAndPromoteResult, [string]>((c, done) => {
    const tauri = (
      window as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__
    const hook = (
      window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } }
    ).cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done({ threadRootId: '', workspaceId: '', repoPath: '' })
      return
    }
    let workspaceId = ''
    let repoPath = ''
    tauri
      .invoke('rpc', { method: 'workspace.recent', params: {} })
      .then((r) => {
        const list = r as Array<{ id: string; repoPath: string }>
        if (list.length === 0) throw new Error('no recent workspaces')
        workspaceId = list[0]!.id
        repoPath = list[0]!.repoPath
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
      .then((node) => hook.reload().then(() => done({ threadRootId: (node as { id: string }).id, workspaceId, repoPath })))
      .catch(() => done({ threadRootId: '', workspaceId: '', repoPath: '' }))
  }, content)
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

interface StreamCallResult {
  events: Array<{ kind: string; [k: string]: unknown }>
  result: { turnId: string; reason: string }
}

async function driveSendPrompt(
  threadRootId: string,
  prompt: string,
  repoPath: string,
): Promise<StreamCallResult> {
  return browser.executeAsync<StreamCallResult, [string, string, string]>(
    (id, p, repo, done) => {
      const hook = (
        window as unknown as {
          cedarpadE2E?: {
            sendPrompt: (
              threadRootId: string,
              prompt: string,
              repoPath: string,
            ) => Promise<StreamCallResult>
          }
        }
      ).cedarpadE2E
      if (!hook?.sendPrompt) {
        done({ events: [], result: { turnId: '', reason: 'error' } })
        return
      }
      hook
        .sendPrompt(id, p, repo)
        .then((r) => done(r))
        .catch((e) => done({ events: [{ kind: 'error', message: String(e) }], result: { turnId: '', reason: 'error' } }))
    },
    threadRootId,
    prompt,
    repoPath,
  )
}

describe('webview e2e (slice 3): SDK runner end-to-end (fake SDK)', () => {
  it('streams Block Nodes from sdk.sendPrompt into the active Thread', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom in case a prior spec left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { threadRootId, workspaceId, repoPath } = await createAndPromote(
      'cedarpad slice3 sdk-runner spec',
    )
    if (!threadRootId) throw new Error('createAndPromote failed')

    try {
      const { events, result } = await driveSendPrompt(threadRootId, 'what is this repo?', repoPath)

      if (result.reason !== 'done') {
        throw new Error(`expected reason=done; got ${JSON.stringify(result)} events=${JSON.stringify(events)}`)
      }
      if (!result.turnId) throw new Error(`turnId missing in result: ${JSON.stringify(result)}`)

      // Fake script: text → tool_use → tool_result → text → result
      // ⇒ 4 block-completes, 1 turn-complete.
      const completes = events.filter((e) => e.kind === 'block-complete')
      if (completes.length !== 4) {
        throw new Error(`expected 4 block-completes; got ${completes.length}: ${JSON.stringify(events)}`)
      }
      const turnComplete = events.find((e) => e.kind === 'turn-complete')
      if (!turnComplete) throw new Error('no turn-complete event')

      // The Tree shows the Turn + 4 block children under our Thread Root.
      const snapshot = await rows()
      const idx = snapshot.findIndex((r) => r.nodeId === threadRootId)
      if (idx < 0) throw new Error('Thread Root row vanished')
      const trDepth = snapshot[idx]!.depth
      const subtree: VisualRow[] = []
      for (let i = idx + 1; i < snapshot.length; i++) {
        if (snapshot[i]!.depth <= trDepth) break
        subtree.push(snapshot[i]!)
      }
      const visuals = subtree.map((r) => r.visual)
      if (!visuals.includes('turn')) throw new Error(`turn missing: ${JSON.stringify(subtree)}`)
      if (!visuals.includes('block-text')) throw new Error(`block-text missing`)
      if (!visuals.includes('block-tool-use')) throw new Error(`block-tool-use missing`)
      if (!visuals.includes('block-tool-result')) throw new Error(`block-tool-result missing`)
      const blocks = subtree.filter((r) => r.kind === 'block')
      if (blocks.length !== 4) {
        throw new Error(`expected 4 block rows; got ${blocks.length}: ${JSON.stringify(blocks)}`)
      }
    } finally {
      if (threadRootId) await deleteNode(workspaceId, threadRootId)
    }
  })
})
