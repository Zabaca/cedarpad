/**
 * Single source of truth for cross-process IPC between the Tauri renderer
 * and the Bun sidecar.
 *
 * Both sides import schemas from this file and parse at the boundary:
 *   - renderer parses outgoing input + incoming output
 *   - sidecar parses incoming input + outgoing output
 *
 * Types are derived via `z.infer` — never mirror as hand-written interfaces.
 *
 * JSON columns in libSQL (e.g. `nodes.metadata`) are described by zod schemas
 * here so encode/decode at the storage boundary stays type-safe.
 */
// Use namespace import — zod 3.25's named `z` export is unreliable under
// vitest+bun's transformer (TypeError: undefined is not an object). The
// namespace form mirrors zod's own index.js (`import * as z`).
import * as z from 'zod'

// ---------- Block / Thread shapes (slice 2) ----------

/**
 * The structured pieces of a Claude turn. Each Block Node carries one of
 * these as the canonical encoding of its payload via `nodes.metadata`.
 *
 * Slice 2 introduces fixture turns only; the Claude SDK (slice 3) feeds
 * real `tool_use` / `tool_result` blocks through the same shape.
 */
export const BlockKindSchema = z.enum(['text', 'tool_use', 'tool_result'])
export type BlockKind = z.infer<typeof BlockKindSchema>

export const TextBlockPayloadSchema = z.object({
  kind: z.literal('text'),
  text: z.string(),
})
export const ToolUseBlockPayloadSchema = z.object({
  kind: z.literal('tool_use'),
  toolName: z.string(),
  toolUseId: z.string().optional(),
  input: z.unknown(),
})
export const ToolResultBlockPayloadSchema = z.object({
  kind: z.literal('tool_result'),
  toolUseId: z.string().optional(),
  output: z.unknown(),
  isError: z.boolean().optional(),
})
export const BlockPayloadSchema = z.discriminatedUnion('kind', [
  TextBlockPayloadSchema,
  ToolUseBlockPayloadSchema,
  ToolResultBlockPayloadSchema,
])
export type BlockPayload = z.infer<typeof BlockPayloadSchema>

/** Marker stored in metadata of a Turn Node. */
export const TurnMetadataSchema = z.object({
  role: z.literal('turn'),
  threadRootId: z.string(),
})
export type TurnMetadata = z.infer<typeof TurnMetadataSchema>

/** Marker stored in metadata of a Block Node — wraps its payload. */
export const BlockMetadataSchema = z.object({
  role: z.literal('block'),
  threadRootId: z.string(),
  payload: BlockPayloadSchema,
})
export type BlockMetadata = z.infer<typeof BlockMetadataSchema>

/** Marker stored in metadata of a Content Node that has been promoted to a Thread Root. */
export const ThreadRootMetadataSchema = z.object({
  isThreadRoot: z.literal(true),
})
export type ThreadRootMetadata = z.infer<typeof ThreadRootMetadataSchema>

// ---------- JSON column schemas ----------

/**
 * Open-ended union: Content Nodes carry arbitrary metadata (incl. the
 * thread-root marker), Turn / Block Nodes carry the typed shapes above.
 *
 * We use `passthrough` + an optional discriminator rather than a strict
 * discriminated union so legacy rows (`metadata: {}`) keep parsing.
 * `threadEngine` parses metadata against the strict shapes when it cares.
 */
export const NodeMetadataSchema = z.object({}).passthrough()
export type NodeMetadata = z.infer<typeof NodeMetadataSchema>

// ---------- Domain shapes ----------

export const NodeKindSchema = z.enum(['content', 'turn', 'block'])
export type NodeKind = z.infer<typeof NodeKindSchema>

export const NodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  position: z.string(),
  kind: NodeKindSchema,
  content: z.string(),
  metadata: NodeMetadataSchema,
  completed: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Node = z.infer<typeof NodeSchema>

// ---------- Outline RPC ----------

export const OutlineCreateInputSchema = z.object({
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  prevSiblingId: z.string().nullable().optional(),
  content: z.string().default(''),
  kind: NodeKindSchema.default('content'),
  metadata: NodeMetadataSchema.default({}),
})
export type OutlineCreateInput = z.infer<typeof OutlineCreateInputSchema>

export const OutlineGetInputSchema = z.object({
  workspaceId: z.string(),
  id: z.string(),
})
export type OutlineGetInput = z.infer<typeof OutlineGetInputSchema>

export const OutlineUpdateInputSchema = z.object({
  workspaceId: z.string(),
  id: z.string(),
  content: z.string().optional(),
  completed: z.boolean().optional(),
  metadata: NodeMetadataSchema.optional(),
})
export type OutlineUpdateInput = z.infer<typeof OutlineUpdateInputSchema>

export const OutlineMoveInputSchema = z.object({
  workspaceId: z.string(),
  id: z.string(),
  newParentId: z.string().nullable(),
  prevSiblingId: z.string().nullable().optional(),
})
export type OutlineMoveInput = z.infer<typeof OutlineMoveInputSchema>

export const OutlineDeleteInputSchema = z.object({
  workspaceId: z.string(),
  id: z.string(),
})
export type OutlineDeleteInput = z.infer<typeof OutlineDeleteInputSchema>

export const OutlineGetChildrenInputSchema = z.object({
  workspaceId: z.string(),
  parentId: z.string().nullable(),
})
export type OutlineGetChildrenInput = z.infer<typeof OutlineGetChildrenInputSchema>

export const OutlineSearchInputSchema = z.object({
  workspaceId: z.string(),
  query: z.string(),
})
export type OutlineSearchInput = z.infer<typeof OutlineSearchInputSchema>

// ---------- Thread RPC (slice 2) ----------

export const ThreadStartInputSchema = z.object({
  workspaceId: z.string(),
  rootNodeId: z.string(),
})
export type ThreadStartInput = z.infer<typeof ThreadStartInputSchema>

export const ThreadAppendPromptInputSchema = z.object({
  workspaceId: z.string(),
  threadRootId: z.string(),
  content: z.string(),
})
export type ThreadAppendPromptInput = z.infer<typeof ThreadAppendPromptInputSchema>

export const ThreadAppendTurnInputSchema = z.object({
  workspaceId: z.string(),
  threadRootId: z.string(),
  blocks: z.array(BlockPayloadSchema),
})
export type ThreadAppendTurnInput = z.infer<typeof ThreadAppendTurnInputSchema>

export const ThreadAppendTurnOutputSchema = z.object({
  turn: NodeSchema,
  blocks: z.array(NodeSchema),
})
export type ThreadAppendTurnOutput = z.infer<typeof ThreadAppendTurnOutputSchema>

// ---------- Workspace RPC ----------

export const WorkspaceSummarySchema = z.object({
  id: z.string(),
  repoPath: z.string(),
  displayName: z.string(),
  dbPath: z.string(),
  lastOpenedAt: z.number(),
  /** Persisted Workflowy-style zoom pointer: id of the visible-root Node, or null = workspace root. */
  activeNodeId: z.string().nullable(),
})
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>

export const WorkspaceOpenInputSchema = z.object({
  repoPath: z.string(),
})
export type WorkspaceOpenInput = z.infer<typeof WorkspaceOpenInputSchema>

export const WorkspaceSwitchInputSchema = z.object({
  id: z.string(),
})
export type WorkspaceSwitchInput = z.infer<typeof WorkspaceSwitchInputSchema>

export const WorkspaceRecentInputSchema = z.object({})
export type WorkspaceRecentInput = z.infer<typeof WorkspaceRecentInputSchema>

export const WorkspaceSetActiveNodeInputSchema = z.object({
  id: z.string(),
  activeNodeId: z.string().nullable(),
})
export type WorkspaceSetActiveNodeInput = z.infer<typeof WorkspaceSetActiveNodeInputSchema>

// ---------- Method registry ----------

/**
 * Maps method name → { input, output } schemas. Both sides iterate this
 * registry to validate; no method exists outside it.
 */
export const Methods = {
  ping: {
    input: z.object({ msg: z.string().optional() }),
    output: z.object({ pong: z.literal(true), echo: z.string().optional() }),
  },
  'workspace.open': {
    input: WorkspaceOpenInputSchema,
    output: WorkspaceSummarySchema,
  },
  'workspace.switch': {
    input: WorkspaceSwitchInputSchema,
    output: WorkspaceSummarySchema,
  },
  'workspace.recent': {
    input: WorkspaceRecentInputSchema,
    output: z.array(WorkspaceSummarySchema),
  },
  'workspace.active': {
    input: z.object({}),
    output: WorkspaceSummarySchema.nullable(),
  },
  'workspace.setActiveNode': {
    input: WorkspaceSetActiveNodeInputSchema,
    output: WorkspaceSummarySchema,
  },
  'outline.create': {
    input: OutlineCreateInputSchema,
    output: NodeSchema,
  },
  'outline.get': {
    input: OutlineGetInputSchema,
    output: NodeSchema.nullable(),
  },
  'outline.update': {
    input: OutlineUpdateInputSchema,
    output: NodeSchema,
  },
  'outline.move': {
    input: OutlineMoveInputSchema,
    output: NodeSchema,
  },
  'outline.delete': {
    input: OutlineDeleteInputSchema,
    output: z.object({ deleted: z.number() }),
  },
  'outline.getChildren': {
    input: OutlineGetChildrenInputSchema,
    output: z.array(NodeSchema),
  },
  'outline.search': {
    input: OutlineSearchInputSchema,
    output: z.array(NodeSchema),
  },
  'thread.start': {
    input: ThreadStartInputSchema,
    output: NodeSchema,
  },
  'thread.appendPrompt': {
    input: ThreadAppendPromptInputSchema,
    output: NodeSchema,
  },
  'thread.appendTurn': {
    input: ThreadAppendTurnInputSchema,
    output: ThreadAppendTurnOutputSchema,
  },
} as const satisfies Record<string, { input: z.ZodTypeAny; output: z.ZodTypeAny }>

export type MethodName = keyof typeof Methods
export type MethodInput<M extends MethodName> = z.infer<(typeof Methods)[M]['input']>
export type MethodOutput<M extends MethodName> = z.infer<(typeof Methods)[M]['output']>

// ---------- Wire envelopes ----------

export const RpcRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
})
export type RpcRequest = z.infer<typeof RpcRequestSchema>

export const RpcResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), id: z.string(), result: z.unknown() }),
  z.object({
    kind: z.literal('err'),
    id: z.string(),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
])
export type RpcResponse = z.infer<typeof RpcResponseSchema>
