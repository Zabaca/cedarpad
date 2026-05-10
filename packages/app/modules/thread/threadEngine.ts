/**
 * Thread engine (v1.1 Shape B).
 *
 * Composes the OutlineStore — does not reach into libSQL directly. Owns
 * the verb vocabulary for v1.1 conversation trees:
 *
 *   - `sendPrompt` is the single TDD'd entry point for sending a Content
 *     Node as a Prompt. It decides whether the parent needs to be
 *     stamped as a session-bearer, marks the Content Node as a Prompt
 *     (state: 'streaming'), and drives the SDK runner — Block children
 *     land directly under the Prompt. The "Or" semantics for root-level
 *     Content Nodes (self-stamp + auto-create empty child Prompt + no
 *     SDK call) is also handled here.
 *
 *   - Block lifecycle helpers (`appendBlock`, `markPrompt*`) are used by
 *     the SDK runner to write Block children and update Prompt state as
 *     the SDK streams.
 *
 *   - Session-bearer helpers (`getSessionBearerSdkSessionId`,
 *     `setSessionBearerSdkSessionId`) walk to the nearest session-bearer
 *     ancestor and read/write its `sdkSessionId`. The runner uses these
 *     to wire `resume: sessionId` so linear follow-ups see prior
 *     history (the PR #27 fix).
 *
 * ADR-0006 details the data shape and verb collapse from v1.
 */
import type { OutlineStore } from '../outline/outlineStore.ts'
import type { Node, BlockPayload } from '../outline/types.ts'
import type { RunnerEvent } from '../../src/contract.ts'
import { PromptMetadataSchema, SessionBearerMetadataSchema } from '../../src/contract.ts'

/**
 * SDK runner shape needed by `sendPrompt`. Subset of the full
 * `SdkRunner` interface so tests can stub it without bringing the
 * Claude SDK adapter in. The runner is responsible for translating SDK
 * messages into Block writes (via the engine's `appendBlock`) and for
 * stamping `sdkMessageUuid` on the Prompt.
 */
export interface SendPromptRunner {
  sendPrompt(input: {
    threadId: string
    prompt: string
    repoPath: string
  }): AsyncIterable<RunnerEvent>
  cancel(threadId: string): Promise<void>
}

export interface SendPromptInput {
  /** The Content Node the user pressed Cmd+Enter on. */
  contentNodeId: string
  /** The text of the prompt (already trimmed by the caller). */
  prompt: string
  /** Repo path for the SDK runner's `cwd`. */
  repoPath: string
  /** Required for the actual-send paths. The caller wires the runner. */
  runner: SendPromptRunner
}

/**
 * Outcome of `sendPrompt`. Discriminated so callers can branch:
 *   - `sent` — Prompt is in flight; iterate `events` to drive UI.
 *   - `bootstrapped` — root-level "Or" semantics: the focused node
 *     became a session-bearer, an empty child Prompt was created, and
 *     `newPromptNodeId` is the id to focus. Nothing was sent to Claude.
 */
export type SendPromptOutcome =
  | {
      kind: 'sent'
      promptNodeId: string
      sessionBearerNodeId: string
      events: AsyncIterable<RunnerEvent>
    }
  | {
      kind: 'bootstrapped'
      sessionBearerNodeId: string
      newPromptNodeId: string
    }

export interface ThreadEngine {
  /**
   * Send a Content Node as a Prompt (Cmd+Enter). The single entry point
   * for v1.1 conversation kickoff and follow-up.
   *
   * Three behaviours, decided by tree position:
   *   - parent is a session-bearer → stamp the Content Node as a
   *     streaming Prompt and drive the SDK; Block children land under
   *     the Prompt.
   *   - parent is a Content Node that's NOT a session-bearer → stamp
   *     the parent as a session-bearer (no `sdkSessionId` yet — the
   *     SDK's `system.init` populates that on the first turn), then
   *     same as above.
   *   - root-level (parent is null) → "Or" semantics: stamp the
   *     focused Content Node itself as a session-bearer, create an
   *     empty child Content Node as the next prompt slot, and return
   *     without invoking the SDK.
   */
  sendPrompt(input: SendPromptInput): Promise<SendPromptOutcome>

  /**
   * Append a Block Node child of the given Prompt Node. Used by the
   * SDK runner as Claude streams blocks.
   */
  appendBlock(promptNodeId: string, payload: BlockPayload): Promise<Node>

  /** Stamp the Prompt's metadata with `state: 'streaming'`. */
  markPromptStreaming(promptNodeId: string): Promise<Node>
  /** Stamp the Prompt's metadata with `state: 'done'`. */
  markPromptDone(promptNodeId: string): Promise<Node>
  /** Stamp the Prompt's metadata with `state: 'cancelled'`. */
  markPromptCancelled(promptNodeId: string): Promise<Node>
  /** Stamp the Prompt's metadata with `state: 'interrupted'`. */
  markPromptInterrupted(promptNodeId: string): Promise<Node>

  /**
   * Walk from `promptNodeId` up to the nearest session-bearer ancestor
   * and read its persisted `sdkSessionId`. Returns null if no ancestor
   * is a session-bearer or the bearer hasn't captured a session id yet
   * (e.g. before the first SDK turn). Used by the SDK runner to pass
   * `resume: sessionId` on follow-up turns.
   */
  getSessionBearerSdkSessionId(promptNodeId: string): Promise<string | null>

  /**
   * Find the nearest session-bearer ancestor of `promptNodeId` and
   * stamp its metadata with the SDK-emitted `sessionId`. Idempotent.
   * Throws if no ancestor is a session-bearer (the runner only calls
   * this after `sendPrompt` has run, which guarantees the bearer
   * exists).
   */
  setSessionBearerSdkSessionId(promptNodeId: string, sessionId: string): Promise<Node>

  /**
   * Stamp the Claude SDK assistant-message uuid onto the Prompt's
   * metadata. Last-write-wins: when an SDK turn includes multiple
   * assistant messages, the LAST one is the resumeSessionAt boundary.
   */
  setPromptSdkMessageUuid(promptNodeId: string, uuid: string): Promise<Node>
}

/** True if `meta.sdkSessionId` is a non-empty string. */
function hasSdkSessionId(metadata: unknown): boolean {
  const parsed = SessionBearerMetadataSchema.safeParse(metadata)
  if (!parsed.success) return false
  const sid = parsed.data.sdkSessionId
  return typeof sid === 'string' && sid.length > 0
}

/** True if `meta.sdkSessionId` is present (string OR null) — i.e. node has been stamped. */
function isSessionBearer(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  return Object.prototype.hasOwnProperty.call(metadata, 'sdkSessionId')
}

export function createThreadEngine(store: OutlineStore): ThreadEngine {
  /**
   * Walk from `nodeId` up the parent chain until we find a Content Node
   * carrying the session-bearer marker. Returns null if none.
   */
  async function findNearestSessionBearer(nodeId: string): Promise<Node | null> {
    let cursor: string | null = nodeId
    const seen = new Set<string>()
    while (cursor !== null) {
      if (seen.has(cursor)) return null
      seen.add(cursor)
      const node = await store.getNode(cursor)
      if (!node) return null
      if (node.kind === 'content' && isSessionBearer(node.metadata)) return node
      cursor = node.parentId
    }
    return null
  }

  async function appendBlock(promptNodeId: string, payload: BlockPayload): Promise<Node> {
    const prompt = await store.getNode(promptNodeId)
    if (!prompt) throw new Error(`appendBlock: prompt ${promptNodeId} not found`)
    if (prompt.kind !== 'content') {
      throw new Error(`appendBlock: ${promptNodeId} is a ${prompt.kind} Node, expected content`)
    }
    const existing = await store.getChildren(promptNodeId)
    const prevSiblingId = existing.length > 0 ? existing[existing.length - 1]!.id : null
    const text = payload.kind === 'text' ? payload.text : ''
    return store.createNode({
      parentId: promptNodeId,
      prevSiblingId,
      kind: 'block',
      content: text,
      metadata: { role: 'block', payload },
    })
  }

  async function setPromptState(
    promptNodeId: string,
    state: 'streaming' | 'done' | 'cancelled' | 'interrupted',
  ): Promise<Node> {
    const node = await store.getNode(promptNodeId)
    if (!node) throw new Error(`markPrompt${state}: prompt ${promptNodeId} not found`)
    return store.updateNode({
      id: promptNodeId,
      metadata: { ...node.metadata, state },
    })
  }

  return {
    async sendPrompt({ contentNodeId, prompt, repoPath, runner }) {
      const node = await store.getNode(contentNodeId)
      if (!node) throw new Error(`sendPrompt: node ${contentNodeId} not found`)
      if (node.kind !== 'content') {
        throw new Error(
          `sendPrompt: ${contentNodeId} is a ${node.kind} Node — only Content Nodes can be sent as Prompts`,
        )
      }

      // Resolve parent + session-bearer status.
      const parent = node.parentId ? await store.getNode(node.parentId) : null

      // Root-level "Or" semantics: focused node has no parent. Stamp it
      // as a session-bearer (no sdkSessionId yet — SDK init will fill
      // that on the first send under it), create an empty child Prompt,
      // and return without sending.
      if (!parent) {
        let bearer: Node = node
        if (!isSessionBearer(node.metadata)) {
          bearer = await store.updateNode({
            id: contentNodeId,
            metadata: { ...node.metadata, sdkSessionId: null },
          })
        }
        const existingChildren = await store.getChildren(contentNodeId)
        const lastChildId =
          existingChildren.length > 0 ? existingChildren[existingChildren.length - 1]!.id : null
        const newChild = await store.createNode({
          parentId: contentNodeId,
          prevSiblingId: lastChildId,
          kind: 'content',
          content: '',
        })
        return {
          kind: 'bootstrapped',
          sessionBearerNodeId: bearer.id,
          newPromptNodeId: newChild.id,
        }
      }

      // Non-root: stamp the parent as a session-bearer if it isn't one
      // already. We mark with `sdkSessionId: null` — the runner's
      // `system.init` handler fills the real id on the first SDK turn
      // by calling `setSessionBearerSdkSessionId`.
      if (parent.kind !== 'content') {
        throw new Error(
          `sendPrompt: parent ${parent.id} is a ${parent.kind} Node — Prompts must live under a Content Node`,
        )
      }
      let bearer: Node = parent
      if (!isSessionBearer(parent.metadata)) {
        bearer = await store.updateNode({
          id: parent.id,
          metadata: { ...parent.metadata, sdkSessionId: null },
        })
      }

      // Stamp the Content Node as a streaming Prompt. The SDK runner
      // will append Block children and transition the state on
      // completion / cancel / error.
      await store.updateNode({
        id: contentNodeId,
        metadata: { ...node.metadata, state: 'streaming' },
      })

      const events = runner.sendPrompt({
        threadId: contentNodeId,
        prompt,
        repoPath,
      })
      return {
        kind: 'sent',
        promptNodeId: contentNodeId,
        sessionBearerNodeId: bearer.id,
        events,
      }
    },

    appendBlock,

    async markPromptStreaming(promptNodeId) {
      return setPromptState(promptNodeId, 'streaming')
    },
    async markPromptDone(promptNodeId) {
      return setPromptState(promptNodeId, 'done')
    },
    async markPromptCancelled(promptNodeId) {
      return setPromptState(promptNodeId, 'cancelled')
    },
    async markPromptInterrupted(promptNodeId) {
      return setPromptState(promptNodeId, 'interrupted')
    },

    async getSessionBearerSdkSessionId(promptNodeId) {
      const node = await store.getNode(promptNodeId)
      if (!node) return null
      // Walk from the parent — the Prompt itself may be a session-bearer
      // only in the root-level "Or" case (where the focused node carries
      // both Prompt and bearer markers); the runner is invoked against
      // a Prompt whose bearer is its parent ancestor walk.
      const startId = node.parentId ?? node.id
      let cursor: string | null = startId
      const seen = new Set<string>()
      while (cursor !== null) {
        if (seen.has(cursor)) break
        seen.add(cursor)
        const n = await store.getNode(cursor)
        if (!n) break
        if (n.kind === 'content' && hasSdkSessionId(n.metadata)) {
          // Re-validate the shape to satisfy the contract zod schema.
          const meta = SessionBearerMetadataSchema.parse(n.metadata)
          return typeof meta.sdkSessionId === 'string' ? meta.sdkSessionId : null
        }
        cursor = n.parentId
      }
      return null
    },

    async setSessionBearerSdkSessionId(promptNodeId, sessionId) {
      const node = await store.getNode(promptNodeId)
      if (!node) throw new Error(`setSessionBearerSdkSessionId: node ${promptNodeId} not found`)
      const startId = node.parentId ?? node.id
      const bearer = await findNearestSessionBearer(startId)
      if (!bearer) {
        throw new Error(
          `setSessionBearerSdkSessionId: no session-bearer ancestor for ${promptNodeId}`,
        )
      }
      return store.updateNode({
        id: bearer.id,
        metadata: { ...bearer.metadata, sdkSessionId: sessionId },
      })
    },

    async setPromptSdkMessageUuid(promptNodeId, uuid) {
      const node = await store.getNode(promptNodeId)
      if (!node) throw new Error(`setPromptSdkMessageUuid: prompt ${promptNodeId} not found`)
      // Validate via the prompt schema so callers can trust the metadata
      // shape on read; passthrough preserves coexisting bearer fields.
      const merged = { ...node.metadata, sdkMessageUuid: uuid }
      PromptMetadataSchema.parse(merged)
      return store.updateNode({ id: promptNodeId, metadata: merged })
    },
  }
}
