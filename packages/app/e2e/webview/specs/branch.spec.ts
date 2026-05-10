/**
 * WebView e2e (slice 5): the killer feature — branch from a Block Node
 * into a sibling Thread carrying full prior history through that Block,
 * then send a follow-up prompt in the new branch.
 *
 * Flow per acceptance criteria #6:
 *   1. Start a Thread on a fresh isolated Content Node.
 *   2. Inject a fixture Turn with three Block children (text, tool_use,
 *      tool_result) via `cedarpadE2E.appendTurn` — same shape the slice
 *      2 spec uses.
 *   3. Pick a source Block (the middle one — a tool_use), select it via
 *      the test hook (`cedarpadE2E.selectBlock`), then drive
 *      `cedarpadE2E.branch(blockId)`. We don't synthesise the Cmd+Shift+B
 *      chord — modifier+letter chords are unreliable in WebKit's
 *      WebDriver against contentEditable cells; the unit-tested keymap
 *      + window-keydown wiring covers the user-visible keystroke path.
 *   4. Assert: the new Thread is a child of the original Thread Root,
 *      visually a `thread-root` with the `branched-thread` class set
 *      (carries a `data-branched-from` attribute pointing at the source
 *      Block). The cloned history (one prompt + one Turn with the first
 *      two Blocks of the original) appears under the new Thread Root,
 *      followed by an empty prompt slot.
 *   5. Send a follow-up prompt in the new branch via the e2e fake SDK
 *      and assert a fresh Turn with the canned Blocks renders.
 *
 * Uses `CEDARPAD_E2E_FAKE_SDK=1` from wdio.conf.ts.
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
  // Use thread.appendTurn directly so we can capture the new Block ids
  // (the cedarpadE2E.appendTurn wrapper doesn't return them).
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

interface BranchResult {
  newThreadId: string
  promptNodeId: string
}

async function selectAndBranch(blockId: string): Promise<BranchResult> {
  return browser.executeAsync<BranchResult, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: {
          selectBlock: (id: string | null) => void
          branch: (id: string) => Promise<{ newThreadId: string; promptNodeId: string }>
        }
      }
    ).cedarpadE2E
    if (!hook) {
      done({ newThreadId: '', promptNodeId: '' })
      return
    }
    hook.selectBlock(id)
    hook
      .branch(id)
      .then((out) => done(out))
      .catch(() => done({ newThreadId: '', promptNodeId: '' }))
  }, blockId)
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

describe('webview e2e (slice 5): branch from a Block into a sibling Thread', () => {
  it('forks history through the source Block and accepts a follow-up in the new branch', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom — earlier specs may have left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { threadRootId, workspaceId, repoPath } = await createAndPromote(
      'cedarpad slice5 branch spec',
    )
    if (!threadRootId) throw new Error('createAndPromote failed')

    try {
      // ---- seed: original Thread with one fixture Turn (3 blocks) ----
      const blockIds = await injectFixtureTurn(threadRootId)
      if (blockIds.length !== 3) {
        throw new Error(`expected 3 fixture blocks; got ${blockIds.length}`)
      }
      // We branch from the middle block (the tool_use).
      const sourceBlockId = blockIds[1]!

      // ---- branch ----
      const { newThreadId, promptNodeId } = await selectAndBranch(sourceBlockId)
      if (!newThreadId) throw new Error('branch returned empty newThreadId')
      if (!promptNodeId) throw new Error('branch returned empty promptNodeId')

      // ---- assertions on tree shape ----
      let snapshot = await rows()
      const newThreadRow = snapshot.find((r) => r.nodeId === newThreadId)
      if (!newThreadRow) {
        throw new Error(
          `new Thread Root not in DOM: ${JSON.stringify(snapshot.map((r) => r.nodeId))}`,
        )
      }
      if (newThreadRow.visual !== 'thread-root') {
        throw new Error(`expected new Thread visual=thread-root; got ${newThreadRow.visual}`)
      }
      // The branch attribute lets the user (and the spec) recognise it
      // as a sibling fork.
      if (newThreadRow.branchedFrom !== sourceBlockId) {
        throw new Error(
          `expected branchedFrom=${sourceBlockId} on new Thread Root; got ${JSON.stringify(newThreadRow)}`,
        )
      }

      // The original Thread Root's subtree now contains the new sibling
      // Thread Root + its descendants alongside the original turn.
      let originalSubtree = subtreeOf(snapshot, threadRootId)
      const branchSubtree = subtreeOf(snapshot, newThreadId)
      // The seeded fixture Turn was injected directly via thread.appendTurn
      // — no preceding human-prompt Content Node before it under the
      // original Thread Root. So the branch's cloned-history portion is
      // just the cloned Turn (carrying the first 2 of 3 source blocks),
      // followed by the empty prompt slot. Expect:
      //   - 1 content row  (the empty prompt slot)
      //   - 1 turn         (the cloned source Turn)
      //   - 2 blocks       (text + tool_use; the tool_result is excluded)
      const branchKinds = branchSubtree.map((r) => r.kind)
      const branchPrompts = branchSubtree.filter((r) => r.kind === 'content')
      const branchTurns = branchSubtree.filter((r) => r.kind === 'turn')
      const branchBlocks = branchSubtree.filter((r) => r.kind === 'block')
      if (branchPrompts.length !== 1) {
        throw new Error(`expected 1 content row in branch (empty prompt slot); got ${branchPrompts.length}: ${JSON.stringify(branchPrompts)}`)
      }
      if (branchTurns.length !== 1) {
        throw new Error(`expected 1 turn in branch; got ${branchTurns.length}`)
      }
      if (branchBlocks.length !== 2) {
        throw new Error(
          `expected 2 cloned blocks in branch (text + tool_use); got ${branchBlocks.length}: ${JSON.stringify(branchBlocks)}, kinds=${JSON.stringify(branchKinds)}`,
        )
      }

      // The empty prompt slot id should match `promptNodeId`.
      if (!branchSubtree.some((r) => r.nodeId === promptNodeId)) {
        throw new Error(`prompt slot ${promptNodeId} not in branch subtree`)
      }

      // Original Thread Root still has its prompt-slot + 1 turn + 3 blocks.
      // (Plus the new sibling Thread Root + its subtree appear as further
      // children of the original.) Filter to direct-depth-children to
      // confirm the original's ORIGINAL siblings remain intact.
      const origRootDepth = snapshot.find((r) => r.nodeId === threadRootId)!.depth
      const origDirectChildren = originalSubtree.filter((r) => r.depth === origRootDepth + 1)
      // direct children: any auto-seeded prompt (slice 4 effect), the
      // injected turn, plus the new sibling Thread Root. We assert at
      // least one turn is still present and the new Thread Root is
      // among the direct children.
      const origTurnsAtRoot = origDirectChildren.filter((r) => r.kind === 'turn')
      if (origTurnsAtRoot.length !== 1) {
        throw new Error(
          `expected 1 original turn under original Thread Root; got ${origTurnsAtRoot.length}: ${JSON.stringify(origDirectChildren)}`,
        )
      }
      if (!origDirectChildren.some((r) => r.nodeId === newThreadId)) {
        throw new Error(
          `new Thread Root is not a direct child of original Thread Root: ${JSON.stringify(origDirectChildren)}`,
        )
      }

      // ---- send a follow-up in the new branch ----
      const turn = await driveSendPrompt(newThreadId, 'follow up question', repoPath)
      if (turn.result.reason !== 'done') {
        throw new Error(`branch follow-up: expected reason=done; got ${JSON.stringify(turn)}`)
      }
      snapshot = await rows()
      const branchAfter = subtreeOf(snapshot, newThreadId)
      const branchTurnsAfter = branchAfter.filter((r) => r.kind === 'turn')
      // Cloned turn + the new turn driven by the fake SDK = 2 turns.
      if (branchTurnsAfter.length !== 2) {
        throw new Error(
          `expected 2 turns in branch after follow-up; got ${branchTurnsAfter.length}: ${JSON.stringify(branchTurnsAfter)}`,
        )
      }
      // The new turn's state is `done` since the fake SDK fully completes.
      const newTurnState = branchTurnsAfter[1]!
      if (snapshot.find((r) => r.nodeId === newTurnState.nodeId)?.kind !== 'turn') {
        throw new Error(`unexpected last branch turn shape`)
      }
      // The fake SDK script lays down 4 block rows per turn (text,
      // tool_use, tool_result, text). Cloned-history blocks = 2; new
      // turn blocks = 4 → total 6 in the branch subtree.
      const branchBlocksAfter = branchAfter.filter((r) => r.kind === 'block')
      if (branchBlocksAfter.length !== 6) {
        throw new Error(
          `expected 6 blocks in branch after follow-up (2 cloned + 4 new); got ${branchBlocksAfter.length}`,
        )
      }
    } finally {
      // Tearing down the original Thread Root cascades to its descendants
      // (FK ON DELETE CASCADE) — this includes the new sibling Thread Root,
      // since it lives as a child of the original.
      if (threadRootId) await deleteNode(workspaceId, threadRootId)
    }
  })
})
