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
  }
}
