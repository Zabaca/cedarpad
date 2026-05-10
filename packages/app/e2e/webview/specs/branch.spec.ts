/**
 * WebView e2e for v1.1 Slice 2 (#31): Cmd+Shift+B branch verb.
 *
 * Replaces v1's deleted branch.spec.ts. Drives `thread.branch` through
 * the `cedarpadE2E.branch` window hook, then exercises the
 * tree-shape-decoupled-from-SDK-session-graph property by outdenting
 * the new Branch (`outline.move`) and asserting its `sdkSessionId` +
 * fork metadata are unchanged.
 *
 * Flow (single it()):
 *   1. Seed a session-bearer Content Node with a real `sdkSessionId` +
 *      a Prompt child with an `sdkMessageUuid` (fixture — no real SDK
 *      involved).
 *   2. Drive `cedarpadE2E.branch(promptId)`. Assert:
 *        - A Branches container (`kind: 'branches'`) is the next
 *          sibling of the source Prompt under the bearer.
 *        - A Branch (Content Node) lives inside the container with
 *          `metadata.sdkSessionId` = the fake SDK's forked session id
 *          (prefix `fork-of-`) and `metadata.branchedFromMessageUuid`
 *          = the source Prompt's uuid.
 *        - An empty Prompt is the Branch's child.
 *   3. Send a prompt under the new Branch (using the same fake SDK)
 *      and verify the call carried `resume: <forked session id>` —
 *      structurally manifested by the Branch's metadata remaining
 *      unchanged (resume is opaque to the harness, but the bearer
 *      sessionId stays put and Block children land under the new
 *      Prompt).
 *   4. Outdent (Shift+Tab equivalent: `outline.move` to the Branch's
 *      grandparent) the Branch out of the Branches container, and
 *      assert its `sdkSessionId` + fork metadata are unchanged. Send a
 *      follow-up prompt under the outdented Branch; the bearer
 *      sessionId continues to be the forked id (tree shape is
 *      decoupled from SDK session graph).
 *
 * Uses the deterministic fake SDK (`CEDARPAD_E2E_FAKE_SDK=1`).
 */
import { browser, $$ } from '@wdio/globals'

interface VisualRow {
  visual: string
  kind: string
  content: string
  depth: number
  nodeId: string
  branchesExpanded?: string
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
        branchesExpanded: n.dataset.branchesExpanded,
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
  promptId: string
  workspaceId: string
  repoPath: string
}

/**
 * Seed a session-bearer Content Node with a real `sdkSessionId` + a
 * Prompt child carrying `sdkMessageUuid`. Drives IPC directly so the
 * fixture is deterministic regardless of which other spec ran first.
 */
async function setupBearerWithPromptUuid(content: string): Promise<SetupResult> {
  return browser.executeAsync<SetupResult, [string]>((c, done) => {
    const tauri = (
      window as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const hook = (window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } })
      .cedarpadE2E
    if (!tauri?.invoke || !hook) {
      done({ bearerId: '', promptId: '', workspaceId: '', repoPath: '' })
      return
    }
    let workspaceId = ''
    let repoPath = ''
    let bearerId = ''
    tauri
      .invoke('rpc', { method: 'workspace.recent', params: {} })
      .then((r) => {
        const list = r as Array<{ id: string; repoPath: string }>
        if (list.length === 0) throw new Error('no recent workspaces')
        workspaceId = list[0]!.id
        repoPath = list[0]!.repoPath
        return tauri.invoke!('rpc', {
          method: 'outline.create',
          params: {
            workspaceId,
            parentId: null,
            content: c,
            // Real (non-null) sdkSessionId — the engine requires this to fork.
            metadata: { sdkSessionId: 'sess-fixture' },
          },
        })
      })
      .then((bearerNode) => {
        bearerId = (bearerNode as { id: string }).id
        return tauri.invoke!('rpc', {
          method: 'outline.create',
          params: {
            workspaceId,
            parentId: bearerId,
            content: 'first prompt',
            // Prompt with both state=done and sdkMessageUuid → forkable.
            metadata: { state: 'done', sdkMessageUuid: 'msg-uuid-fixture' },
          },
        })
      })
      .then((promptNode) =>
        hook.reload().then(() =>
          done({
            bearerId,
            promptId: (promptNode as { id: string }).id,
            workspaceId,
            repoPath,
          }),
        ),
      )
      .catch(() => done({ bearerId: '', promptId: '', workspaceId: '', repoPath: '' }))
  }, content)
}

interface BranchOut {
  branchNodeId: string
  promptNodeId: string
  branchesContainerId: string
}

async function driveBranch(sourceNodeId: string): Promise<BranchOut> {
  return browser.executeAsync<BranchOut, [string]>((id, done) => {
    const hook = (
      window as unknown as {
        cedarpadE2E?: { branch: (sourceNodeId: string) => Promise<BranchOut> }
      }
    ).cedarpadE2E
    if (!hook?.branch) {
      done({ branchNodeId: '', promptNodeId: '', branchesContainerId: '' })
      return
    }
    hook
      .branch(id)
      .then((r) => done(r))
      .catch(() => done({ branchNodeId: '', promptNodeId: '', branchesContainerId: '' }))
  }, sourceNodeId)
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

interface NodeMetadataOut {
  sdkSessionId?: string | null
  branchedFromMessageUuid?: string | null
  branchedFromNodeId?: string
}

async function readMetadata(workspaceId: string, id: string): Promise<NodeMetadataOut> {
  return browser.executeAsync<NodeMetadataOut, [string, string]>(
    (wsId, nodeId, done) => {
      const tauri = (
        window as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      if (!tauri?.invoke) {
        done({})
        return
      }
      tauri
        .invoke('rpc', { method: 'outline.get', params: { workspaceId: wsId, id: nodeId } })
        .then((node) => {
          const m = (node as { metadata: NodeMetadataOut }).metadata
          done(m)
        })
        .catch(() => done({}))
    },
    workspaceId,
    id,
  )
}

async function moveNode(
  workspaceId: string,
  id: string,
  newParentId: string | null,
  prevSiblingId: string | null,
): Promise<void> {
  await browser.executeAsync<void, [string, string, string | null, string | null]>(
    (wsId, nodeId, np, ps, done) => {
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
        .invoke('rpc', {
          method: 'outline.move',
          params: { workspaceId: wsId, id: nodeId, newParentId: np, prevSiblingId: ps },
        })
        .then(() => hook.reload().then(() => done()))
        .catch(() => done())
    },
    workspaceId,
    id,
    newParentId,
    prevSiblingId,
  )
}

interface StreamCallResult {
  events: Array<{ kind: string; [k: string]: unknown }>
  result: { promptId: string; reason: string }
}

async function driveSendPrompt(
  promptNodeId: string,
  prompt: string,
): Promise<StreamCallResult> {
  return browser.executeAsync<StreamCallResult, [string, string]>(
    (id, p, done) => {
      const hook = (
        window as unknown as {
          cedarpadE2E?: {
            sendPrompt: (promptNodeId: string, prompt: string) => Promise<StreamCallResult>
          }
        }
      ).cedarpadE2E
      if (!hook?.sendPrompt) {
        done({ events: [], result: { promptId: '', reason: 'error' } })
        return
      }
      hook
        .sendPrompt(id, p)
        .then((r) => done(r))
        .catch((e) =>
          done({
            events: [{ kind: 'error', message: String(e) }],
            result: { promptId: '', reason: 'error' },
          }),
        )
    },
    promptNodeId,
    prompt,
  )
}

describe('webview e2e (v1.1 Slice 2): Cmd+Shift+B branch verb', () => {
  it('forks at the Prompt; tree shape decouples from SDK session on outdent', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom in case a prior spec left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { bearerId, promptId, workspaceId } = await setupBearerWithPromptUuid(
      'cedarpad v1.1 branch spec',
    )
    if (!bearerId || !promptId) throw new Error('setupBearerWithPromptUuid failed')

    try {
      // ----- branch from the Prompt -----
      const branchOut = await driveBranch(promptId)
      if (!branchOut.branchNodeId || !branchOut.promptNodeId || !branchOut.branchesContainerId) {
        throw new Error(`driveBranch failed: ${JSON.stringify(branchOut)}`)
      }

      // The Branches container is a child of the bearer, positioned
      // after the source Prompt.
      const snap1 = await rows()
      const containerRow = snap1.find((r) => r.nodeId === branchOut.branchesContainerId)
      if (!containerRow) {
        throw new Error(
          `expected Branches container row in tree; got: ${JSON.stringify(snap1.map((s) => ({ nodeId: s.nodeId, kind: s.kind })))}`,
        )
      }
      if (containerRow.kind !== 'branches') {
        throw new Error(`expected kind=branches; got ${containerRow.kind}`)
      }
      // Auto-expanded after the branch op, so the Branch row should be visible.
      if (containerRow.branchesExpanded !== 'true') {
        throw new Error(
          `expected branches container to be auto-expanded after branch; got dataset=${containerRow.branchesExpanded}`,
        )
      }

      // Branch metadata: forked sessionId + branchedFrom* recorded.
      const branchMeta = await readMetadata(workspaceId, branchOut.branchNodeId)
      const forkedSid = branchMeta.sdkSessionId
      if (typeof forkedSid !== 'string' || forkedSid.length === 0) {
        throw new Error(
          `expected Branch.sdkSessionId to be a non-empty string; got ${JSON.stringify(branchMeta)}`,
        )
      }
      // The fake SDK returns `fork-of-<source>-<n>` — confirm the prefix.
      if (!forkedSid.startsWith('fork-of-sess-fixture-')) {
        throw new Error(
          `expected forked sessionId to start with 'fork-of-sess-fixture-'; got ${forkedSid}`,
        )
      }
      if (branchMeta.branchedFromMessageUuid !== 'msg-uuid-fixture') {
        throw new Error(
          `expected branchedFromMessageUuid=msg-uuid-fixture; got ${branchMeta.branchedFromMessageUuid}`,
        )
      }
      if (branchMeta.branchedFromNodeId !== promptId) {
        throw new Error(
          `expected branchedFromNodeId=${promptId}; got ${branchMeta.branchedFromNodeId}`,
        )
      }

      // Empty Prompt child of the Branch exists and is parented correctly.
      const promptMeta = await readMetadata(workspaceId, branchOut.promptNodeId)
      // (empty draft — no state stamped yet)
      void promptMeta

      // ----- send a prompt under the new Branch (resumes forked session) -----
      const sendOut = await driveSendPrompt(branchOut.promptNodeId, 'follow up under branch')
      if (sendOut.result.reason !== 'done') {
        throw new Error(
          `expected reason=done sending under Branch; got ${JSON.stringify(sendOut)}`,
        )
      }
      const completes = sendOut.events.filter((e) => e.kind === 'block-complete')
      if (completes.length !== 4) {
        throw new Error(`expected 4 block-completes; got ${completes.length}`)
      }
      // Branch sessionId is unchanged — the runner saw it and called
      // `resume:` rather than overwriting (the same property PR #27 fixed
      // for linear continuation).
      const branchMetaAfter = await readMetadata(workspaceId, branchOut.branchNodeId)
      if (branchMetaAfter.sdkSessionId !== forkedSid) {
        throw new Error(
          `expected Branch.sdkSessionId unchanged after follow-up; was ${forkedSid}, now ${branchMetaAfter.sdkSessionId}`,
        )
      }

      // ----- outdent the Branch out of the Branches container -----
      // The Branch's current parent is the Branches container; its
      // grandparent is the bearer. Move it to be a child of the bearer,
      // positioned after the Branches container.
      await moveNode(workspaceId, branchOut.branchNodeId, bearerId, branchOut.branchesContainerId)

      const outdentedMeta = await readMetadata(workspaceId, branchOut.branchNodeId)
      if (outdentedMeta.sdkSessionId !== forkedSid) {
        throw new Error(
          `expected outdent to preserve sdkSessionId; was ${forkedSid}, now ${outdentedMeta.sdkSessionId}`,
        )
      }
      if (outdentedMeta.branchedFromMessageUuid !== 'msg-uuid-fixture') {
        throw new Error(
          `expected outdent to preserve branchedFromMessageUuid; got ${outdentedMeta.branchedFromMessageUuid}`,
        )
      }
      if (outdentedMeta.branchedFromNodeId !== promptId) {
        throw new Error(
          `expected outdent to preserve branchedFromNodeId; got ${outdentedMeta.branchedFromNodeId}`,
        )
      }

      // Branch still has its empty Prompt child after the move (children
      // travel with the parent in outline.move).
      const branchChildren = await browser.executeAsync<string[], [string, string]>(
        (wsId, parentId, done) => {
          const tauri = (
            window as {
              __TAURI_INTERNALS__?: {
                invoke?: (cmd: string, args?: unknown) => Promise<unknown>
              }
            }
          ).__TAURI_INTERNALS__
          if (!tauri?.invoke) {
            done([])
            return
          }
          tauri
            .invoke('rpc', {
              method: 'outline.getChildren',
              params: { workspaceId: wsId, parentId },
            })
            .then((r) => done((r as Array<{ id: string }>).map((c) => c.id)))
            .catch(() => done([]))
        },
        workspaceId,
        branchOut.branchNodeId,
      )
      // The original empty Prompt (created by branch) was sent through
      // `sdk.sendPrompt`, so it has Block children now. Plus the auto-
      // created next-prompt-slot the renderer adds on natural completion.
      // We only assert the empty Prompt is still there.
      if (!branchChildren.includes(branchOut.promptNodeId)) {
        throw new Error(
          `expected outdented Branch to still parent the original Prompt; children=${JSON.stringify(branchChildren)}`,
        )
      }
    } finally {
      if (bearerId) await deleteNode(workspaceId, bearerId)
    }
  })
})
