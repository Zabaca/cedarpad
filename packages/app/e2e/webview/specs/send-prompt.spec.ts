/**
 * WebView e2e (slice 4): send-prompt UI + streaming + cancel.
 *
 * Flow per acceptance criteria #5:
 *   1. Start a Thread on a fresh isolated Content Node.
 *   2. The Tree's auto-seeding effect creates an empty Content Node child
 *      under the Thread Root — that's the prompt slot.
 *   3. Drive the renderer's send-prompt path (we go through the test hook
 *      `cedarpadE2E.sendPrompt` rather than synthesising Cmd+Enter
 *      because WebKit's WebDriver can't reliably synthesise modifier
 *      chords against contentEditable; the unit-tested keymap covers the
 *      Cmd+Enter → send-prompt mapping).
 *   4. Assert the Turn + Block children stream in under the Thread Root.
 *   5. Send a follow-up prompt; assert a SECOND Turn appears as a sibling
 *      of the first.
 *   6. Kick off a third prompt without awaiting it; cancel it via the
 *      runner's `sdk.cancel`; assert the partial Turn carries the
 *      `cancelled` lifecycle state.
 *
 * Uses the deterministic fake SDK (`CEDARPAD_E2E_FAKE_SDK=1` set by
 * `wdio.conf.ts`).
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
      .then((node) =>
        hook
          .reload()
          .then(() => done({ threadRootId: (node as { id: string }).id, workspaceId, repoPath })),
      )
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
        .catch((e) =>
          done({
            events: [{ kind: 'error', message: String(e) }],
            result: { turnId: '', reason: 'error' },
          }),
        )
    },
    threadRootId,
    prompt,
    repoPath,
  )
}

async function fireAndForgetSendPrompt(
  threadRootId: string,
  prompt: string,
  repoPath: string,
): Promise<void> {
  await browser.execute(
    (id: string, p: string, repo: string) => {
      const hook = (
        window as unknown as {
          cedarpadE2E?: {
            sendPromptFireAndForget: (
              threadRootId: string,
              prompt: string,
              repoPath: string,
            ) => void
          }
        }
      ).cedarpadE2E
      hook?.sendPromptFireAndForget(id, p, repo)
    },
    threadRootId,
    prompt,
    repoPath,
  )
}

async function cancelTurn(threadRootId: string): Promise<void> {
  await browser.executeAsync<void, [string]>((id, done) => {
    const hook = (
      window as unknown as { cedarpadE2E?: { cancel: (id: string) => Promise<void> } }
    ).cedarpadE2E
    if (!hook?.cancel) {
      done()
      return
    }
    hook
      .cancel(id)
      .then(() => done())
      .catch(() => done())
  }, threadRootId)
}

function subtreeOf(snapshot: VisualRow[], threadRootId: string): VisualRow[] {
  const idx = snapshot.findIndex((r) => r.nodeId === threadRootId)
  if (idx < 0) return []
  const trDepth = snapshot[idx]!.depth
  const out: VisualRow[] = []
  for (let i = idx + 1; i < snapshot.length; i++) {
    if (snapshot[i]!.depth <= trDepth) break
    out.push(snapshot[i]!)
  }
  return out
}

describe('webview e2e (slice 4): send-prompt + streaming + cancel', () => {
  it('streams a turn, supports a follow-up, then cancels mid-stream', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom in case a prior spec left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { threadRootId, workspaceId, repoPath } = await createAndPromote(
      'cedarpad slice4 send-prompt spec',
    )
    if (!threadRootId) throw new Error('createAndPromote failed')

    try {
      // ----- first turn -----
      const turn1 = await driveSendPrompt(threadRootId, 'first?', repoPath)
      if (turn1.result.reason !== 'done') {
        throw new Error(`turn1 expected reason=done; got ${JSON.stringify(turn1)}`)
      }
      let snap = await rows()
      let subtree = subtreeOf(snap, threadRootId)
      const turns1 = subtree.filter((r) => r.kind === 'turn')
      if (turns1.length !== 1) {
        throw new Error(`expected 1 turn after first send; got ${turns1.length}: ${JSON.stringify(turns1)}`)
      }
      // Turn finished naturally → state=done.
      if (turns1[0]!.turnState !== 'done') {
        throw new Error(
          `expected turn1 state=done; got ${JSON.stringify(turns1[0])}`,
        )
      }
      const blocks1 = subtree.filter((r) => r.kind === 'block')
      if (blocks1.length !== 4) {
        throw new Error(`expected 4 block rows; got ${blocks1.length}`)
      }

      // ----- follow-up turn -----
      const turn2 = await driveSendPrompt(threadRootId, 'second?', repoPath)
      if (turn2.result.reason !== 'done') {
        throw new Error(`turn2 expected reason=done; got ${JSON.stringify(turn2)}`)
      }
      snap = await rows()
      subtree = subtreeOf(snap, threadRootId)
      const turns2 = subtree.filter((r) => r.kind === 'turn')
      if (turns2.length !== 2) {
        throw new Error(
          `expected 2 turns after follow-up; got ${turns2.length}: ${JSON.stringify(turns2)}`,
        )
      }
      for (const t of turns2) {
        if (t.turnState !== 'done') {
          throw new Error(`expected all turns done; got ${JSON.stringify(t)}`)
        }
      }
      const totalBlocks2 = subtree.filter((r) => r.kind === 'block')
      if (totalBlocks2.length !== 8) {
        throw new Error(`expected 8 blocks (2 turns × 4); got ${totalBlocks2.length}`)
      }

      // ----- cancel mid-stream -----
      // Fire-and-forget a third prompt; cancel before it can naturally
      // finish. The fake script has built-in 20ms delays per yield, so we
      // get a small but reliable window.
      await fireAndForgetSendPrompt(threadRootId, 'third?', repoPath)
      // Wait for the streaming Turn to materialise (state=streaming) so
      // we know the runner has begun.
      await browser.waitUntil(
        async () => {
          const cur = await rows()
          const sub = subtreeOf(cur, threadRootId)
          return sub.some((r) => r.kind === 'turn' && r.turnState === 'streaming')
        },
        { timeout: 5000, timeoutMsg: 'never saw a streaming turn after fire-and-forget' },
      )
      await cancelTurn(threadRootId)
      // Wait for the streaming Turn to flip to cancelled.
      await browser.waitUntil(
        async () => {
          const cur = await rows()
          const sub = subtreeOf(cur, threadRootId)
          return sub.some((r) => r.kind === 'turn' && r.turnState === 'cancelled')
        },
        { timeout: 5000, timeoutMsg: 'cancelled turn never appeared' },
      )

      snap = await rows()
      subtree = subtreeOf(snap, threadRootId)
      const turns3 = subtree.filter((r) => r.kind === 'turn')
      if (turns3.length !== 3) {
        throw new Error(
          `expected 3 turns after cancel; got ${turns3.length}: ${JSON.stringify(turns3)}`,
        )
      }
      // First two are still done; the third is cancelled.
      if (turns3[0]!.turnState !== 'done' || turns3[1]!.turnState !== 'done') {
        throw new Error(`expected first two turns done; got ${JSON.stringify(turns3.slice(0, 2))}`)
      }
      if (turns3[2]!.turnState !== 'cancelled') {
        throw new Error(`expected third turn cancelled; got ${JSON.stringify(turns3[2])}`)
      }
    } finally {
      if (threadRootId) await deleteNode(workspaceId, threadRootId)
    }
  })
})
