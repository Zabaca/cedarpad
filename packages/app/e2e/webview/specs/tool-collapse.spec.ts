/**
 * WebView e2e (v1.1 slice 3): tool blocks default-collapse + visual pair-grouping.
 *
 * Drives the deterministic fake SDK to produce a known sequence:
 *   text → tool_use(tu_1) → tool_result(tu_1) → text
 * After the send completes the tool_use+tool_result pair must render as a
 * single collapsed ToolPair row (one chevron). Clicking the chevron must
 * expand the pair into two separate Block rows.
 */
import { browser, $$, $ } from '@wdio/globals'

interface VisualRow {
  visual: string
  kind: string
  nodeId: string
  collapsed?: string
}

async function rows(): Promise<VisualRow[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.tree-node')) as HTMLElement[]
    return nodes.map((n) => ({
      visual: n.dataset.visual ?? 'unknown',
      kind: n.dataset.kind ?? 'unknown',
      nodeId: n.dataset.nodeId ?? '',
      collapsed: n.dataset.collapsed,
    }))
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

async function setupBearerWithPrompt(content: string): Promise<SetupResult> {
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
            metadata: { sdkSessionId: null },
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
            content: 'collapse spec prompt',
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

interface StreamCallResult {
  events: Array<{ kind: string; [k: string]: unknown }>
  result: { promptId: string; reason: string }
}

async function driveSendPrompt(promptNodeId: string, prompt: string): Promise<StreamCallResult> {
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

describe('webview e2e (v1.1 slice 3): default-collapsed tool blocks + ToolPair visual unit', () => {
  it('renders tool_use + tool_result as one collapsed ToolPair; chevron expands both', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom in case a prior spec left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { bearerId, promptId, workspaceId } = await setupBearerWithPrompt(
      'cedarpad v1.1 tool-collapse spec',
    )
    if (!bearerId || !promptId) throw new Error('setupBearerWithPrompt failed')

    try {
      const send = await driveSendPrompt(promptId, 'collapse?')
      if (send.result.reason !== 'done') {
        throw new Error(`send expected reason=done; got ${JSON.stringify(send.result)}`)
      }
      // The fake script emits 4 block-completes (text, tool_use, tool_result, text).
      const completes = send.events.filter((e) => e.kind === 'block-complete')
      if (completes.length !== 4) {
        throw new Error(`expected 4 block-completes; got ${completes.length}`)
      }

      // Default-collapsed assertion: the tree should contain exactly one
      // `tool-pair` row (no separate visual-block-tool-use / -tool-result
      // rows under the Prompt) and the two text blocks render as
      // single block-text rows.
      let snap = await rows()
      const pairRows = snap.filter((r) => r.visual === 'tool-pair')
      if (pairRows.length !== 1) {
        throw new Error(
          `expected 1 tool-pair row by default; got ${pairRows.length}: ${JSON.stringify(pairRows)}`,
        )
      }
      const toolUseRows = snap.filter((r) => r.visual === 'block-tool-use')
      const toolResultRows = snap.filter((r) => r.visual === 'block-tool-result')
      if (toolUseRows.length !== 0 || toolResultRows.length !== 0) {
        throw new Error(
          `expected no separate tool-use/tool-result rows when collapsed; got ${toolUseRows.length}/${toolResultRows.length}`,
        )
      }
      // The pair row reports collapsed=true.
      if (pairRows[0]!.collapsed !== 'true') {
        throw new Error(
          `expected tool-pair row to be data-collapsed=true; got ${pairRows[0]!.collapsed}`,
        )
      }

      // Click the pair chevron — expect the pair to split into two
      // separate visual-block-tool-use / -tool-result rows.
      const pairId = pairRows[0]!.nodeId
      const chevron = await $(`.tree-node[data-node-id="${pairId}"] [data-testid="pair-chevron"]`)
      await chevron.click()
      await browser.pause(120)

      snap = await rows()
      const pairAfter = snap.filter((r) => r.visual === 'tool-pair')
      if (pairAfter.length !== 0) {
        throw new Error(
          `expected pair to disappear after expand; still ${pairAfter.length} pair rows`,
        )
      }
      const useAfter = snap.filter((r) => r.visual === 'block-tool-use')
      const resAfter = snap.filter((r) => r.visual === 'block-tool-result')
      if (useAfter.length !== 1 || resAfter.length !== 1) {
        throw new Error(
          `expected 1 tool-use + 1 tool-result row after expand; got ${useAfter.length}/${resAfter.length}`,
        )
      }
      // Both expanded block rows should report data-collapsed=false.
      if (useAfter[0]!.collapsed !== 'false' || resAfter[0]!.collapsed !== 'false') {
        throw new Error(
          `expected expanded block rows to be data-collapsed=false; got use=${useAfter[0]!.collapsed} res=${resAfter[0]!.collapsed}`,
        )
      }
    } finally {
      if (bearerId) await deleteNode(workspaceId, bearerId)
    }
  })
})
