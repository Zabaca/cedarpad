/**
 * Thread engine.
 *
 * Composes the OutlineStore — does not reach into libSQL directly. Owns the
 * verb vocabulary for Threads: promote a Content Node into a Thread Root,
 * append a user prompt as a child, append a Claude turn as a Turn Node with
 * Block Node children.
 *
 * Slice 2 ships these three verbs against a fixture turn (no SDK yet).
 * Slice 3 adds the SDK runner that drives `appendTurn` with real Claude
 * events; the three branch verbs land in slice 5+.
 */
import type { OutlineStore } from '../outline/outlineStore.ts'
import type { Node, BlockPayload } from '../outline/types.ts'

export interface ThreadEngine {
  /**
   * Promote a Content Node into a Thread Root by stamping
   * `isThreadRoot: true` into its metadata. Throws if the target is a Turn
   * or Block Node, or if the target node does not exist.
   */
  startThread(rootNodeId: string): Promise<Node>

  /**
   * Append a Content Node child of the Thread Root carrying the user's
   * prompt text. Returns the new Node.
   */
  appendPrompt(threadRootId: string, content: string): Promise<Node>

  /**
   * Append a Turn Node child of the Thread Root, then create one Block Node
   * per input block as children of the Turn (in order). Each Block carries
   * its kind + structured payload via metadata.
   */
  appendTurn(threadRootId: string, blocks: BlockPayload[]): Promise<{ turn: Node; blocks: Node[] }>

  /**
   * Streaming variant of {@link appendTurn} (slice 3+, used by the SDK
   * runner). Creates the Turn Node up front and stamps `state: 'streaming'`
   * so crash recovery (slice 4) can find it on next launch if the process
   * dies mid-turn. The caller streams Block payloads in via {@link appendBlock}
   * as they arrive from Claude; on natural completion call
   * {@link markTurnDone}; on user-driven cancellation call
   * {@link markTurnCancelled}; on app-crash recovery, the scan calls
   * {@link markTurnInterrupted}.
   */
  beginTurn(threadRootId: string): Promise<Node>
  appendBlock(turnId: string, payload: BlockPayload): Promise<Node>
  /** Stamp the Turn Node's metadata with `state: 'done'`. */
  markTurnDone(turnId: string): Promise<Node>
  /** Stamp the Turn Node's metadata with `state: 'cancelled'`. */
  markTurnCancelled(turnId: string): Promise<Node>
  /** Stamp the Turn Node's metadata with `state: 'interrupted'`. */
  markTurnInterrupted(turnId: string): Promise<Node>
}

export function createThreadEngine(store: OutlineStore): ThreadEngine {
  return {
    async startThread(rootNodeId) {
      const node = await store.getNode(rootNodeId)
      if (!node) throw new Error(`thread.start: node ${rootNodeId} not found`)
      if (node.kind !== 'content') {
        throw new Error(
          `thread.start: cannot start a Thread on a ${node.kind} Node — only Content Nodes can become Thread Roots`,
        )
      }
      const updated = await store.updateNode({
        id: rootNodeId,
        metadata: { ...node.metadata, isThreadRoot: true },
      })
      return updated
    },

    async appendPrompt(threadRootId, content) {
      const children = await store.getChildren(threadRootId)
      const prevSiblingId = children.length > 0 ? children[children.length - 1]!.id : null
      return store.createNode({
        parentId: threadRootId,
        prevSiblingId,
        content,
        kind: 'content',
      })
    },

    async appendTurn(threadRootId, blocks) {
      const existing = await store.getChildren(threadRootId)
      const prevSiblingId = existing.length > 0 ? existing[existing.length - 1]!.id : null
      const turn = await store.createNode({
        parentId: threadRootId,
        prevSiblingId,
        kind: 'turn',
        content: '',
        metadata: { role: 'turn', threadRootId },
      })

      const created: Node[] = []
      let lastBlockId: string | null = null
      for (const payload of blocks) {
        const text = payload.kind === 'text' ? payload.text : ''
        const block = await store.createNode({
          parentId: turn.id,
          prevSiblingId: lastBlockId,
          kind: 'block',
          content: text,
          metadata: { role: 'block', threadRootId, payload },
        })
        created.push(block)
        lastBlockId = block.id
      }
      return { turn, blocks: created }
    },

    async beginTurn(threadRootId) {
      const existing = await store.getChildren(threadRootId)
      const prevSiblingId = existing.length > 0 ? existing[existing.length - 1]!.id : null
      return store.createNode({
        parentId: threadRootId,
        prevSiblingId,
        kind: 'turn',
        content: '',
        metadata: { role: 'turn', threadRootId, state: 'streaming' },
      })
    },

    async appendBlock(turnId, payload) {
      const turn = await store.getNode(turnId)
      if (!turn) throw new Error(`appendBlock: turn ${turnId} not found`)
      if (turn.kind !== 'turn') throw new Error(`appendBlock: ${turnId} is a ${turn.kind} Node, expected turn`)
      const turnMeta = turn.metadata as { threadRootId?: string }
      const threadRootId = turnMeta.threadRootId ?? ''
      const existing = await store.getChildren(turnId)
      const prevSiblingId = existing.length > 0 ? existing[existing.length - 1]!.id : null
      const text = payload.kind === 'text' ? payload.text : ''
      return store.createNode({
        parentId: turnId,
        prevSiblingId,
        kind: 'block',
        content: text,
        metadata: { role: 'block', threadRootId, payload },
      })
    },

    async markTurnDone(turnId) {
      const turn = await store.getNode(turnId)
      if (!turn) throw new Error(`markTurnDone: turn ${turnId} not found`)
      return store.updateNode({
        id: turnId,
        metadata: { ...turn.metadata, state: 'done' },
      })
    },

    async markTurnCancelled(turnId) {
      const turn = await store.getNode(turnId)
      if (!turn) throw new Error(`markTurnCancelled: turn ${turnId} not found`)
      return store.updateNode({
        id: turnId,
        // Keep `cancelled: true` for back-compat with code that may look at
        // the legacy boolean; the canonical signal is `state: 'cancelled'`.
        metadata: { ...turn.metadata, state: 'cancelled', cancelled: true },
      })
    },

    async markTurnInterrupted(turnId) {
      const turn = await store.getNode(turnId)
      if (!turn) throw new Error(`markTurnInterrupted: turn ${turnId} not found`)
      return store.updateNode({
        id: turnId,
        metadata: { ...turn.metadata, state: 'interrupted' },
      })
    },
  }
}
