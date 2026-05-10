/**
 * WebView e2e (slice 6): the other two branch verbs — retry and
 * newSibling — exercised end-to-end alongside the existing branch
 * verb in a single scenario, per the issue's "full coverage of all
 * three branch verbs in a single test scenario" requirement.
 *
 * Flow:
 *   1. Start a Thread on a fresh isolated Content Node.
 *   2. Inject a fixture Turn with three Block children (text, tool_use,
 *      tool_result) via thread.appendTurn.
 *   3. RETRY from the middle Block (the tool_use). The new sibling
 *      Thread should clone history *up to but excluding* that Block —
 *      i.e. only the first text Block from the source Turn.
 *   4. NEW SIBLING under the original Thread Root. Empty Thread, no
 *      cloned history at all.
 *   5. As a sanity check we also run BRANCH from the same source Block
 *      so all three sibling Threads coexist under the original Thread
 *      Root, in creation order, each with the right shape.
 *
 * Like slice 5's branch.spec.ts we don't synthesise the Cmd+Shift+R /
 * Cmd+Shift+N chords — modifier+letter chords are unreliable in
 * WebKit's WebDriver against contentEditable cells. The unit-tested
 * keymap doc + window-keydown wiring covers the user-visible keystroke
 * path; the e2e drives the IPCs via the cedarpadE2E hook.
 *
 * Uses CEDARPAD_E2E_FAKE_SDK=1 from wdio.conf.ts.
 */
import { browser, $$ } from '@wdio/globals'

interface VisualRow {
  visual: string
  kind: string
  content: string
  depth: number
  nodeId: string
  branchedFrom?: string
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
        branchedFrom: n.dataset.branchedFrom,
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

async function injectFixtureTurn(threadRootId: string): Promise<string[]> {
  return browser.executeAsync<string[], [string]>((id, done) => {
    const tauri = (
      window as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    ).__TAURI_INTERNALS__
    const hook = (
      window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } }
    ).cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done([])
      return
    }
    tauri
      .invoke('rpc', { method: 'workspace.recent', params: {} })
      .then((r) => {
        const list = r as Array<{ id: string }>
        if (list.length === 0) throw new Error('no recent workspaces')
        return tauri.invoke!('rpc', {
          method: 'thread.appendTurn',
          params: {
            workspaceId: list[0]!.id,
            threadRootId: id,
            blocks: [
              { kind: 'text', text: 'Looking at README' },
              { kind: 'tool_use', toolName: 'Read', toolUseId: 'tu_1', input: { path: 'README.md' } },
              { kind: 'tool_result', toolUseId: 'tu_1', output: 'cedarpad outliner' },
            ],
          },
        })
      })
      .then((out) => {
        const blocks = (out as { blocks: Array<{ id: string }> }).blocks.map((b) => b.id)
        return hook.reload().then(() => done(blocks))
      })
      .catch(() => done([]))
  }, threadRootId)
}

interface VerbResult {
  newThreadId: string
  promptNodeId: string
}

async function selectAndBranch(blockId: string): Promise<VerbResult> {
  return browser.executeAsync<VerbResult, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: {
          selectBlock: (id: string | null) => void
          branch: (id: string) => Promise<VerbResult>
        }
      }
    ).cedarpadE2E
    if (!hook) {
      done({ newThreadId: '', promptNodeId: '' })
      return
    }
    hook.selectBlock(id)
    hook.branch(id).then((out) => done(out)).catch(() => done({ newThreadId: '', promptNodeId: '' }))
  }, blockId)
}

async function selectAndRetry(blockId: string): Promise<VerbResult> {
  return browser.executeAsync<VerbResult, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: {
          selectBlock: (id: string | null) => void
          retry: (id: string) => Promise<VerbResult>
        }
      }
    ).cedarpadE2E
    if (!hook?.retry) {
      done({ newThreadId: '', promptNodeId: '' })
      return
    }
    hook.selectBlock(id)
    hook.retry(id).then((out) => done(out)).catch(() => done({ newThreadId: '', promptNodeId: '' }))
  }, blockId)
}

async function selectAndNewSibling(threadRootId: string): Promise<VerbResult> {
  return browser.executeAsync<VerbResult, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: {
          selectThreadRoot: (id: string | null) => void
          newSibling: (id: string) => Promise<VerbResult>
        }
      }
    ).cedarpadE2E
    if (!hook?.newSibling) {
      done({ newThreadId: '', promptNodeId: '' })
      return
    }
    hook.selectThreadRoot(id)
    hook
      .newSibling(id)
      .then((out) => done(out))
      .catch(() => done({ newThreadId: '', promptNodeId: '' }))
  }, threadRootId)
}

function subtreeOf(snapshot: VisualRow[], rootId: string): VisualRow[] {
  const idx = snapshot.findIndex((r) => r.nodeId === rootId)
  if (idx < 0) return []
  const trDepth = snapshot[idx]!.depth
  const out: VisualRow[] = []
  for (let i = idx + 1; i < snapshot.length; i++) {
    if (snapshot[i]!.depth <= trDepth) break
    out.push(snapshot[i]!)
  }
  return out
}

describe('webview e2e (slice 6): retry + newSibling alongside branch', () => {
  it('forks via all three verbs and produces correctly-shaped sibling Threads', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom — earlier specs may have left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { threadRootId, workspaceId } = await createAndPromote(
      'cedarpad slice6 retry+newsibling spec',
    )
    if (!threadRootId) throw new Error('createAndPromote failed')

    try {
      // ---- seed: original Thread with one fixture Turn (3 blocks) ----
      const blockIds = await injectFixtureTurn(threadRootId)
      if (blockIds.length !== 3) {
        throw new Error(`expected 3 fixture blocks; got ${blockIds.length}`)
      }
      // We act on the middle block (the tool_use) for both branch and
      // retry so the comparison is exact.
      const sourceBlockId = blockIds[1]!

      // ---- BRANCH ----
      const branched = await selectAndBranch(sourceBlockId)
      if (!branched.newThreadId) throw new Error('branch returned empty newThreadId')

      // ---- RETRY ----
      const retried = await selectAndRetry(sourceBlockId)
      if (!retried.newThreadId) throw new Error('retry returned empty newThreadId')
      if (retried.newThreadId === branched.newThreadId) {
        throw new Error('retry produced the same Thread id as branch — should be a fresh sibling')
      }

      // ---- NEW SIBLING ----
      const fresh = await selectAndNewSibling(threadRootId)
      if (!fresh.newThreadId) throw new Error('newSibling returned empty newThreadId')

      // ---- assertions on tree shape ----
      const snapshot = await rows()

      const branchRow = snapshot.find((r) => r.nodeId === branched.newThreadId)
      const retryRow = snapshot.find((r) => r.nodeId === retried.newThreadId)
      const freshRow = snapshot.find((r) => r.nodeId === fresh.newThreadId)
      if (!branchRow || !retryRow || !freshRow) {
        throw new Error(
          `one or more new Thread Roots missing from DOM: ${JSON.stringify({
            branched,
            retried,
            fresh,
            ids: snapshot.map((r) => r.nodeId),
          })}`,
        )
      }
      for (const row of [branchRow, retryRow, freshRow]) {
        if (row.visual !== 'thread-root') {
          throw new Error(`expected sibling Thread visual=thread-root; got ${row.visual}`)
        }
      }
      // Branch + Retry siblings carry branchedFrom = sourceBlockId.
      if (branchRow.branchedFrom !== sourceBlockId) {
        throw new Error(
          `branch sibling missing branchedFrom marker: ${JSON.stringify(branchRow)}`,
        )
      }
      if (retryRow.branchedFrom !== sourceBlockId) {
        throw new Error(
          `retry sibling missing branchedFrom marker: ${JSON.stringify(retryRow)}`,
        )
      }
      // newSibling explicitly carries no branchedFrom — empty Thread,
      // no source point.
      if (freshRow.branchedFrom) {
        throw new Error(
          `newSibling thread should not carry branchedFrom; got ${freshRow.branchedFrom}`,
        )
      }

      // The original Thread Root has all three new siblings as direct
      // children, in creation order: branch, retry, fresh.
      const origRootRow = snapshot.find((r) => r.nodeId === threadRootId)!
      const origDirectChildren = subtreeOf(snapshot, threadRootId).filter(
        (r) => r.depth === origRootRow.depth + 1,
      )
      const directIds = origDirectChildren.map((c) => c.nodeId)
      if (
        directIds.indexOf(branched.newThreadId) < 0 ||
        directIds.indexOf(retried.newThreadId) < 0 ||
        directIds.indexOf(fresh.newThreadId) < 0
      ) {
        throw new Error(
          `not all sibling Threads appear as direct children of original Thread Root: ${JSON.stringify(
            directIds,
          )}`,
        )
      }
      if (
        directIds.indexOf(branched.newThreadId) >= directIds.indexOf(retried.newThreadId) ||
        directIds.indexOf(retried.newThreadId) >= directIds.indexOf(fresh.newThreadId)
      ) {
        throw new Error(
          `sibling Threads not in expected creation order [branch, retry, fresh]: ${JSON.stringify(
            directIds,
          )}`,
        )
      }

      // ---- shape of each sibling Thread ----

      // BRANCH: cloned Turn carries first 2 of 3 blocks (text + tool_use)
      // + empty prompt slot. Same shape as branch.spec.ts.
      const branchSubtree = subtreeOf(snapshot, branched.newThreadId)
      const branchPrompts = branchSubtree.filter((r) => r.kind === 'content')
      const branchTurns = branchSubtree.filter((r) => r.kind === 'turn')
      const branchBlocks = branchSubtree.filter((r) => r.kind === 'block')
      if (branchPrompts.length !== 1) {
        throw new Error(
          `branch sibling: expected 1 prompt slot; got ${branchPrompts.length}`,
        )
      }
      if (branchTurns.length !== 1) {
        throw new Error(`branch sibling: expected 1 turn; got ${branchTurns.length}`)
      }
      if (branchBlocks.length !== 2) {
        throw new Error(
          `branch sibling: expected 2 blocks (text + tool_use); got ${branchBlocks.length}`,
        )
      }

      // RETRY: cloned Turn carries only the first 1 of 3 blocks (text);
      // tool_use is excluded. Plus empty prompt slot.
      const retrySubtree = subtreeOf(snapshot, retried.newThreadId)
      const retryPrompts = retrySubtree.filter((r) => r.kind === 'content')
      const retryTurns = retrySubtree.filter((r) => r.kind === 'turn')
      const retryBlocks = retrySubtree.filter((r) => r.kind === 'block')
      if (retryPrompts.length !== 1) {
        throw new Error(
          `retry sibling: expected 1 prompt slot; got ${retryPrompts.length}: ${JSON.stringify(retryPrompts)}`,
        )
      }
      if (retryTurns.length !== 1) {
        throw new Error(`retry sibling: expected 1 turn; got ${retryTurns.length}`)
      }
      if (retryBlocks.length !== 1) {
        throw new Error(
          `retry sibling: expected 1 block (just the preceding text); got ${retryBlocks.length}: ${JSON.stringify(retryBlocks)}`,
        )
      }

      // NEW SIBLING: empty Thread — only the prompt slot, no Turn, no Blocks.
      const freshSubtree = subtreeOf(snapshot, fresh.newThreadId)
      const freshPrompts = freshSubtree.filter((r) => r.kind === 'content')
      const freshTurns = freshSubtree.filter((r) => r.kind === 'turn')
      const freshBlocks = freshSubtree.filter((r) => r.kind === 'block')
      if (freshPrompts.length !== 1) {
        throw new Error(
          `newSibling: expected exactly 1 prompt slot; got ${freshPrompts.length}: ${JSON.stringify(freshSubtree)}`,
        )
      }
      if (freshTurns.length !== 0) {
        throw new Error(`newSibling should carry no turns; got ${freshTurns.length}`)
      }
      if (freshBlocks.length !== 0) {
        throw new Error(`newSibling should carry no blocks; got ${freshBlocks.length}`)
      }
      // The empty prompt slot id matches what the IPC returned.
      if (freshPrompts[0]!.nodeId !== fresh.promptNodeId) {
        throw new Error(
          `newSibling prompt slot mismatch: returned ${fresh.promptNodeId}, found ${freshPrompts[0]!.nodeId}`,
        )
      }
    } finally {
      // FK ON DELETE CASCADE wipes all three sibling Threads with the
      // original Thread Root.
      if (threadRootId) await deleteNode(workspaceId, threadRootId)
    }
  })
})
