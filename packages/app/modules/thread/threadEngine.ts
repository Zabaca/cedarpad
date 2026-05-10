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
 * events; the streaming verbs (`beginTurn`/`appendBlock`/`markTurn*`)
 * land here.
 *
 * Slice 5 adds `branch(sourceBlockId)` — the killer verb. Internally
 * implemented via the unified `branchInternal({ sourceBlockId, mode })`
 * operation which all three branch verbs (Branch / Retry / NewSibling)
 * reduce to per the PRD; only `Branch` is publicly surfaced in slice 5.
 * Slice 6 will expose the other two as thin wrappers over the same
 * internal op.
 */
import type { OutlineStore } from '../outline/outlineStore.ts'
import type { Node, BlockPayload } from '../outline/types.ts'
import { BlockMetadataSchema } from '../../src/contract.ts'

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

  /**
   * Branch from a Block Node. Creates a new sibling Thread (its own
   * Content-Node-as-Thread-Root marked `isThreadRoot: true`) under the
   * same parent as the original Thread Root. The new Thread's children
   * mirror the conversation history through the source Block; an empty
   * Content Node is appended as the next prompt slot. Returns the new
   * Thread Root id and the prompt slot id (the renderer focuses the
   * latter).
   */
  branch(sourceBlockId: string): Promise<{ newThreadId: string; promptNodeId: string }>

  /**
   * Retry from a Block Node. Like {@link branch}, but the cloned history
   * goes up to but EXCLUDES the source Block — equivalent to "regenerate
   * / edit-and-resend" in linear chat tools, expressed as a tree fork
   * that preserves the original Thread.
   */
  retry(sourceBlockId: string): Promise<{ newThreadId: string; promptNodeId: string }>

  /**
   * Open a fresh Thread under the same Thread Root with no conversation
   * history at all. The argument is the Thread Root, not a Block —
   * there's no source point inside the conversation.
   */
  newSibling(threadRootId: string): Promise<{ newThreadId: string; promptNodeId: string }>
}

/**
 * Mode for the unified branch operation. Only `branch` is publicly
 * exposed in slice 5 (`engine.branch(sourceBlockId)` is a thin wrapper).
 * Slice 6 adds `retry` and `new-sibling` wrappers over the same
 * internal op.
 *
 * - `branch`      — history slice = up to AND INCLUDING the source Block.
 * - `retry`       — history slice = up to but EXCLUDING the source Block.
 * - `new-sibling` — empty history (fresh Thread under the same Root).
 */
export type BranchMode = 'branch' | 'retry' | 'new-sibling'

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

    async branch(sourceBlockId) {
      return branchInternal(store, { sourceBlockId, mode: 'branch' })
    },

    async retry(sourceBlockId) {
      return branchInternal(store, { sourceBlockId, mode: 'retry' })
    },

    async newSibling(threadRootId) {
      return branchInternal(store, { threadRootId, mode: 'new-sibling' })
    },
  }
}

/**
 * Unified branch operation. All three branch verbs (Branch / Retry /
 * NewSibling) reduce to one history-slicing op:
 *
 *   - `branch` | `retry`  — input is a source Block; the original Thread
 *      Root is its Turn's parent. History slice ends at the source Turn,
 *      with the source Turn itself contributing blocks up to (and for
 *      `branch` only, including) the source Block.
 *   - `new-sibling`       — input is the Thread Root directly. History
 *      slice is empty: we just stamp a fresh Thread Root sibling and
 *      hang an empty prompt slot off it.
 *
 * Steps:
 *   1. Resolve the original Thread Root + (when applicable) the source
 *      Block / Turn.
 *   2. Slice history per `mode`.
 *   3. Create a new Content Node under the same Thread Root, stamped
 *      `isThreadRoot: true` (and for the block-driven modes,
 *      `branchedFromBlockId`).
 *   4. Replay the sliced history under the new Thread Root.
 *   5. Append an empty prompt Content Node and return its id.
 */
type BranchInternalArgs =
  | { mode: 'branch' | 'retry'; sourceBlockId: string }
  | { mode: 'new-sibling'; threadRootId: string }

async function branchInternal(
  store: OutlineStore,
  args: BranchInternalArgs,
): Promise<{ newThreadId: string; promptNodeId: string }> {
  // Resolve the original Thread Root. For block-driven modes we walk
  // sourceBlock → Turn → Thread Root; for new-sibling we take the id
  // directly and validate it's actually a Thread Root.
  let originalRoot: Node
  let sourceTurn: Node | null = null
  let sourceTurnIdx = -1
  let sourceTurnBlocks: Node[] = []
  let branchedFromBlockId: string | undefined

  if (args.mode === 'new-sibling') {
    const root = await store.getNode(args.threadRootId)
    if (!root) throw new Error(`branch: thread root ${args.threadRootId} not found`)
    if (root.kind !== 'content' || (root.metadata as { isThreadRoot?: unknown }).isThreadRoot !== true) {
      throw new Error(
        `branch: ${args.threadRootId} is not a Thread Root (kind=${root.kind}); newSibling requires a Thread Root`,
      )
    }
    originalRoot = root
  } else {
    const sourceBlockId = args.sourceBlockId
    const sourceBlock = await store.getNode(sourceBlockId)
    if (!sourceBlock) throw new Error(`branch: block ${sourceBlockId} not found`)
    if (sourceBlock.kind !== 'block') {
      throw new Error(`branch: ${sourceBlockId} is a ${sourceBlock.kind} Node, expected block`)
    }
    if (!sourceBlock.parentId) throw new Error(`branch: block ${sourceBlockId} has no Turn parent`)

    const turn = await store.getNode(sourceBlock.parentId)
    if (!turn || turn.kind !== 'turn') {
      throw new Error(`branch: block ${sourceBlockId} is not under a Turn Node`)
    }
    if (!turn.parentId) {
      throw new Error(`branch: turn ${turn.id} has no Thread Root parent`)
    }
    sourceTurn = turn

    const root = await store.getNode(turn.parentId)
    if (!root) throw new Error(`branch: thread root ${turn.parentId} not found`)
    originalRoot = root
    branchedFromBlockId = sourceBlockId
  }

  // Walk the original Thread Root's children in order. For block-driven
  // modes we keep siblings appearing at-or-before the source Turn and
  // slice the source Turn's blocks per mode. For new-sibling there's no
  // history to keep at all.
  const rootChildren = await store.getChildren(originalRoot.id)
  if (sourceTurn) {
    sourceTurnIdx = rootChildren.findIndex((c) => c.id === sourceTurn!.id)
    if (sourceTurnIdx < 0) {
      throw new Error(`branch: source turn ${sourceTurn.id} not found under root ${originalRoot.id}`)
    }
    const allSourceBlocks = await store.getChildren(sourceTurn.id)
    const sourceBlockId = (args as { sourceBlockId: string }).sourceBlockId
    const blockIdx = allSourceBlocks.findIndex((b) => b.id === sourceBlockId)
    if (blockIdx < 0) throw new Error(`branch: source block not found under its turn`)
    sourceTurnBlocks =
      args.mode === 'branch'
        ? allSourceBlocks.slice(0, blockIdx + 1) // include source Block
        : allSourceBlocks.slice(0, blockIdx) // 'retry' — exclude source Block
  }

  // Create the new sibling Thread as a CHILD of the original Thread Root,
  // alongside the existing prompts/turns. Per CONTEXT.md "A Thread Root
  // has one or more Threads as direct children — multiple Threads exist
  // when branching has occurred". The new Thread is itself a Content
  // Node marked `isThreadRoot: true` so send-prompt against its own
  // children routes correctly through the existing prompt-slot logic.
  // It lands as the LAST child so the fork appears below the existing
  // conversation visually.
  const lastSiblingId =
    rootChildren.length > 0 ? rootChildren[rootChildren.length - 1]!.id : null
  const newRootMetadata: Record<string, unknown> = { isThreadRoot: true }
  if (branchedFromBlockId) newRootMetadata.branchedFromBlockId = branchedFromBlockId
  const newRoot = await store.createNode({
    parentId: originalRoot.id,
    prevSiblingId: lastSiblingId,
    kind: 'content',
    content: '',
    metadata: newRootMetadata,
  })

  // Replay history under the new Thread Root.
  let lastChildId: string | null = null
  if (sourceTurn) {
    for (let i = 0; i < sourceTurnIdx; i++) {
      const item = rootChildren[i]!
      lastChildId = await cloneTurnOrPrompt(store, newRoot.id, item, lastChildId)
    }

    // Replay the source Turn — but only when its sliced block list is
    // non-empty. `branch` always keeps at least the source block;
    // `retry` from the first block of the first turn keeps zero blocks
    // (the new branch is "regenerate from before this turn ever ran"),
    // so we must NOT emit an empty Turn shell.
    if (args.mode === 'branch' || (args.mode === 'retry' && sourceTurnBlocks.length > 0)) {
      const clonedTurn = await store.createNode({
        parentId: newRoot.id,
        prevSiblingId: lastChildId,
        kind: 'turn',
        content: '',
        metadata: { role: 'turn', threadRootId: newRoot.id, state: 'done' },
      })
      let prevBlockId: string | null = null
      for (const sb of sourceTurnBlocks) {
        // Pull the payload through the contract schema so the clone's
        // metadata matches what a fresh appendBlock would write — no
        // accidental drift between cloned and live turns.
        const meta = BlockMetadataSchema.parse(sb.metadata)
        const cloned = await store.createNode({
          parentId: clonedTurn.id,
          prevSiblingId: prevBlockId,
          kind: 'block',
          content: sb.content,
          metadata: { role: 'block', threadRootId: newRoot.id, payload: meta.payload },
        })
        prevBlockId = cloned.id
      }
      lastChildId = clonedTurn.id
    }
  }

  // Empty prompt slot at the end — same shape as the slice 4 auto-seed.
  const promptNode = await store.createNode({
    parentId: newRoot.id,
    prevSiblingId: lastChildId,
    kind: 'content',
    content: '',
  })

  return { newThreadId: newRoot.id, promptNodeId: promptNode.id }
}

/**
 * Clone one direct child of a Thread Root (a Content Node prompt or a
 * Turn Node with all its Block children) under `newParentId`, after
 * `prevSiblingId`. Returns the cloned node's id so the caller can chain
 * the next clone after it.
 */
async function cloneTurnOrPrompt(
  store: OutlineStore,
  newParentId: string,
  src: Node,
  prevSiblingId: string | null,
): Promise<string> {
  if (src.kind === 'content') {
    // Cloned prompts are plain Content Nodes — strip any thread-root
    // marker the original Thread Root carried so we don't accidentally
    // create nested Thread Roots inside a branch's history.
    const cloned = await store.createNode({
      parentId: newParentId,
      prevSiblingId,
      kind: 'content',
      content: src.content,
      metadata: {},
    })
    return cloned.id
  }
  if (src.kind === 'turn') {
    const clonedTurn = await store.createNode({
      parentId: newParentId,
      prevSiblingId,
      kind: 'turn',
      content: '',
      // History clones are always done — whether the original was
      // streaming, cancelled, or interrupted, in the new branch it's
      // settled history.
      metadata: { role: 'turn', threadRootId: newParentId, state: 'done' },
    })
    const blocks = await store.getChildren(src.id)
    let prevBlockId: string | null = null
    for (const b of blocks) {
      const meta = BlockMetadataSchema.parse(b.metadata)
      const cloned = await store.createNode({
        parentId: clonedTurn.id,
        prevSiblingId: prevBlockId,
        kind: 'block',
        content: b.content,
        metadata: { role: 'block', threadRootId: newParentId, payload: meta.payload },
      })
      prevBlockId = cloned.id
    }
    return clonedTurn.id
  }
  // Block nodes can't appear as direct children of a Thread Root — no
  // sane caller hits this path, but be defensive.
  throw new Error(`cloneTurnOrPrompt: unexpected kind ${src.kind} under thread root`)
}
