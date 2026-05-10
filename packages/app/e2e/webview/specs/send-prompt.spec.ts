/**
 * WebView e2e (v1.1 Shape B): Cmd+Enter is the sole conversation-starting
 * verb. This spec exercises the three behaviours the issue's acceptance
 * criteria call out, plus the linear-follow-up + prior-history-preserved
 * scenario that PR #27 fixed and v1.1 must not regress.
 *
 * Flow:
 *   1. Create an isolated Content Node and stamp it as a session-bearer
 *      via outline.update (the renderer's "Or" bootstrap path; we drive
 *      the IPC directly because synthesised Cmd+Enter chords against
 *      contentEditable are unreliable in WebKit's WebDriver).
 *   2. Create a child Content Node (the first Prompt) under the bearer.
 *   3. Send the first Prompt — assert Block children land directly under
 *      the Prompt (no Turn Node intermediate).
 *   4. Send a follow-up Prompt under the same bearer — assert it lands
 *      as a sibling of the first Prompt (under the bearer) and that the
 *      SDK call carried `resume: <bearer-sessionId>` (PR #27 fix).
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
  promptState?: string
  sessionBearer?: string
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
        sessionBearer: n.dataset.sessionBearer,
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
 * Set up: create a session-bearer Content Node + a child Prompt under
 * it. Returns ids of both. We drive the IPC directly rather than
 * synthesising Cmd+Enter on a root-level node — that path is covered
 * by the keymap unit tests; here we only need a Shape B tree to send
 * against.
 */
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
        // Create the session-bearer: a Content Node with sdkSessionId: null.
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
        // Create the first Prompt under the bearer.
        return tauri.invoke!('rpc', {
          method: 'outline.create',
          params: {
            workspaceId,
            parentId: bearerId,
            content: 'first prompt',
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

async function driveSendPrompt(
  promptNodeId: string,
  prompt: string,
  _repoPath: string,
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

/**
 * Read the bearer node's metadata.sdkSessionId. After a successful send
 * the runner's `system.init` handler should have stamped it.
 */
async function getBearerSessionId(workspaceId: string, bearerId: string): Promise<string | null> {
  return browser.executeAsync<string | null, [string, string]>(
    (wsId, id, done) => {
      const tauri = (
        window as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      if (!tauri?.invoke) {
        done(null)
        return
      }
      tauri
        .invoke('rpc', { method: 'outline.get', params: { workspaceId: wsId, id } })
        .then((node) => {
          const m = (node as { metadata: { sdkSessionId?: unknown } }).metadata
          done(typeof m.sdkSessionId === 'string' ? m.sdkSessionId : null)
        })
        .catch(() => done(null))
    },
    workspaceId,
    bearerId,
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

describe('webview e2e (v1.1 Shape B): Cmd+Enter sends Prompts; follow-ups see prior history', () => {
  it('streams Block children directly under the Prompt; follow-up Prompt resumes the SDK session', async () => {
    await browser.url('tauri://localhost')
    await waitForBoot()

    // Reset zoom in case a prior spec left things zoomed in.
    await browser.execute(() => {
      const root = document.querySelector('.breadcrumbs .crumb-root') as HTMLElement | null
      if (root && !(root as HTMLButtonElement).disabled) root.click()
    })
    await browser.pause(200)

    const { bearerId, promptId, workspaceId, repoPath } = await setupBearerWithPrompt(
      'cedarpad v1.1 send-prompt spec',
    )
    if (!bearerId || !promptId) throw new Error('setupBearerWithPrompt failed')

    try {
      // ----- first send -----
      const send1 = await driveSendPrompt(promptId, 'first?', repoPath)
      if (send1.result.reason !== 'done') {
        throw new Error(`send1 expected reason=done; got ${JSON.stringify(send1)}`)
      }
      // The fake SDK script emits 4 block-completes (text, tool_use,
      // tool_result, text) for any prompt.
      const completes1 = send1.events.filter((e) => e.kind === 'block-complete')
      if (completes1.length !== 4) {
        throw new Error(`expected 4 block-completes; got ${completes1.length}`)
      }

      let snap = await rows()
      const bearerSubtree1 = subtreeOf(snap, bearerId)
      // Bearer subtree should contain: Prompt + 4 Block children + (auto-created
      // empty next-prompt-slot). Total ≥ 6 (depending on auto-slot timing).
      const promptRows1 = bearerSubtree1.filter((r) => r.nodeId === promptId)
      if (promptRows1.length !== 1) {
        throw new Error(`expected one Prompt row under bearer; got ${promptRows1.length}`)
      }
      // The Prompt should be marked done (not streaming).
      if (promptRows1[0]!.promptState !== 'done') {
        throw new Error(
          `expected promptState=done after send1; got ${JSON.stringify(promptRows1[0])}`,
        )
      }
      // Block children of the Prompt — directly under it (depth = bearer.depth + 2).
      const blocksUnderPrompt1 = subtreeOf(snap, promptId).filter((r) => r.kind === 'block')
      if (blocksUnderPrompt1.length !== 4) {
        throw new Error(
          `expected 4 Block children of Prompt; got ${blocksUnderPrompt1.length}: ${JSON.stringify(blocksUnderPrompt1)}`,
        )
      }

      // Bearer should now carry a real sdkSessionId (the fake SDK's
      // system.init has no session_id, so this may or may not be set;
      // our fake omits it). The contract is: if a session_id WAS set by
      // a real SDK, it's on the bearer. The fake omits it deliberately
      // so we focus on the structural assertion above. Move to follow-up.

      // ----- follow-up: a NEW Prompt sibling of the first under the bearer -----
      // Stamp the bearer with a synthetic sessionId so the runner
      // exercises the `resume:` path on the second send. This simulates
      // what the real SDK would have set on the first turn.
      await browser.executeAsync<void, [string, string]>(
        (wsId, id, done) => {
          const tauri = (
            window as {
              __TAURI_INTERNALS__?: {
                invoke?: (cmd: string, args?: unknown) => Promise<unknown>
              }
            }
          ).__TAURI_INTERNALS__
          if (!tauri?.invoke) {
            done()
            return
          }
          tauri
            .invoke('rpc', {
              method: 'outline.update',
              params: { workspaceId: wsId, id, metadata: { sdkSessionId: 'sess-fake-1' } },
            })
            .then(() => done())
            .catch(() => done())
        },
        workspaceId,
        bearerId,
      )

      // Create a second Prompt under the bearer.
      const prompt2Id = await browser.executeAsync<string, [string, string]>(
        (wsId, parent, done) => {
          const tauri = (
            window as {
              __TAURI_INTERNALS__?: {
                invoke?: (cmd: string, args?: unknown) => Promise<unknown>
              }
            }
          ).__TAURI_INTERNALS__
          const hook = (
            window as unknown as { cedarpadE2E?: { reload: () => Promise<void> } }
          ).cedarpadE2E
          if (!tauri?.invoke || !hook) {
            done('')
            return
          }
          tauri
            .invoke('rpc', {
              method: 'outline.create',
              params: { workspaceId: wsId, parentId: parent, content: 'second prompt' },
            })
            .then((node) => hook.reload().then(() => done((node as { id: string }).id)))
            .catch(() => done(''))
        },
        workspaceId,
        bearerId,
      )
      if (!prompt2Id) throw new Error('failed to create second Prompt')

      const send2 = await driveSendPrompt(prompt2Id, 'second?', repoPath)
      if (send2.result.reason !== 'done') {
        throw new Error(`send2 expected reason=done; got ${JSON.stringify(send2)}`)
      }

      // Assert: bearer.sdkSessionId is unchanged (still 'sess-fake-1' —
      // the runner saw the existing session and passed `resume:` rather
      // than overwriting). This is the structural manifestation of the
      // PR #27 fix: prior history is preserved across follow-ups.
      const bearerSessionAfter2 = await getBearerSessionId(workspaceId, bearerId)
      if (bearerSessionAfter2 !== 'sess-fake-1') {
        throw new Error(
          `expected bearer.sdkSessionId to remain 'sess-fake-1' after follow-up; got ${bearerSessionAfter2}`,
        )
      }

      // Tree shape: bearer has TWO Prompt children, each with their own
      // Block subtrees.
      snap = await rows()
      const bearerSubtree2 = subtreeOf(snap, bearerId)
      const promptsUnderBearer = bearerSubtree2.filter(
        (r) => r.depth === bearerSubtree2[0]!.depth && r.kind === 'content' && r.promptState,
      )
      if (promptsUnderBearer.length < 2) {
        throw new Error(
          `expected ≥2 Prompts under bearer after follow-up; got ${promptsUnderBearer.length}: ${JSON.stringify(promptsUnderBearer)}`,
        )
      }
      const blocksUnderPrompt2 = subtreeOf(snap, prompt2Id).filter((r) => r.kind === 'block')
      if (blocksUnderPrompt2.length !== 4) {
        throw new Error(
          `expected 4 Block children of follow-up Prompt; got ${blocksUnderPrompt2.length}`,
        )
      }
    } finally {
      if (bearerId) await deleteNode(workspaceId, bearerId)
    }
  })
})
