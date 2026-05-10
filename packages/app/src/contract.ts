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

/**
 * Lifecycle of a Turn Node (slice 4):
 *   - `streaming`   — beginTurn fired; SDK runner is producing blocks. If
 *                     the app is killed in this state, crash recovery on
 *                     next launch transitions it to `interrupted`.
 *   - `done`        — turn-complete fired naturally.
 *   - `cancelled`   — user fired sdk.cancel; intentional stop.
 *   - `interrupted` — runner was no longer alive when next launch saw a
 *                     `streaming` Turn. Visually distinct from `cancelled`
 *                     so the user knows the partial output is not a real
 *                     Claude response.
 */
export const TurnStateSchema = z.enum(['streaming', 'done', 'cancelled', 'interrupted'])
export type TurnState = z.infer<typeof TurnStateSchema>

/** Marker stored in metadata of a Turn Node. */
export const TurnMetadataSchema = z.object({
  role: z.literal('turn'),
  threadRootId: z.string(),
  /**
   * Lifecycle state. Optional for back-compat with slice 2 fixture turns
   * that pre-date this field; missing is treated as `done` by the
   * renderer (slice 2 fixture turns were always one-shot).
   */
  state: TurnStateSchema.optional(),
  /**
   * Legacy slice 3 marker — kept for back-compat with already-persisted
   * turns. New code reads `state === 'cancelled'` instead.
   */
  cancelled: z.boolean().optional(),
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

/**
 * Crash recovery (slice 4). On launch the renderer asks the sidecar to scan
 * for any Turn Nodes left in `state: 'streaming'` (no live runner is
 * driving them — necessarily so, since the sidecar process is fresh) and
 * stamp them `state: 'interrupted'`. Returns the ids that were transitioned
 * so the UI can surface them.
 */
export const ThreadScanInterruptedInputSchema = z.object({
  workspaceId: z.string(),
})
export type ThreadScanInterruptedInput = z.infer<typeof ThreadScanInterruptedInputSchema>

export const ThreadScanInterruptedOutputSchema = z.object({
  interruptedTurnIds: z.array(z.string()),
})
export type ThreadScanInterruptedOutput = z.infer<typeof ThreadScanInterruptedOutputSchema>

/**
 * Branch verb (slice 5). From any Block Node, fork the conversation
 * into a sibling Thread under the same Thread Root with full prior
 * history through the source Block. Returns the new Thread Root id and
 * the empty prompt slot id (the renderer focuses the latter).
 */
export const ThreadBranchInputSchema = z.object({
  workspaceId: z.string(),
  blockId: z.string(),
})
export type ThreadBranchInput = z.infer<typeof ThreadBranchInputSchema>

export const ThreadBranchOutputSchema = z.object({
  newThreadId: z.string(),
  promptNodeId: z.string(),
})
export type ThreadBranchOutput = z.infer<typeof ThreadBranchOutputSchema>

/**
 * Retry verb (slice 6). Same shape as branch, distinct method so the
 * sidecar dispatches to `engine.retry` (mode = 'retry'). The cloned
 * history goes up to but EXCLUDES the source Block.
 */
export const ThreadRetryInputSchema = z.object({
  workspaceId: z.string(),
  blockId: z.string(),
})
export type ThreadRetryInput = z.infer<typeof ThreadRetryInputSchema>

export const ThreadRetryOutputSchema = z.object({
  newThreadId: z.string(),
  promptNodeId: z.string(),
})
export type ThreadRetryOutput = z.infer<typeof ThreadRetryOutputSchema>

/**
 * NewSibling verb (slice 6). Argument is the Thread Root id, not a
 * Block — the new sibling Thread carries no conversation history at
 * all.
 */
export const ThreadNewSiblingInputSchema = z.object({
  workspaceId: z.string(),
  threadRootId: z.string(),
})
export type ThreadNewSiblingInput = z.infer<typeof ThreadNewSiblingInputSchema>

export const ThreadNewSiblingOutputSchema = z.object({
  newThreadId: z.string(),
  promptNodeId: z.string(),
})
export type ThreadNewSiblingOutput = z.infer<typeof ThreadNewSiblingOutputSchema>

// ---------- Auth RPC (slice 3) ----------

/**
 * Auth methods are unusual: their **persistence** lives in the Rust shell,
 * not the sidecar. The renderer calls these via `auth.*` IPC for parity
 * with every other contract method, and the sidecar's auth handlers act on
 * its in-process key cache (`keychainStore`). The OS keychain itself is
 * read/written by Rust via the `keyring` crate; Rust pushes the key into
 * the sidecar at startup (and on `setApiKey`) using an internal inject
 * message. The renderer NEVER reads the key back — `getApiKey` is not in
 * this contract by design (see `keychainStore.ts` header).
 */
export const AuthSetApiKeyInputSchema = z.object({
  key: z.string().min(1),
})
export type AuthSetApiKeyInput = z.infer<typeof AuthSetApiKeyInputSchema>

export const AuthHasApiKeyOutputSchema = z.object({
  hasKey: z.boolean(),
})
export type AuthHasApiKeyOutput = z.infer<typeof AuthHasApiKeyOutputSchema>

// ---------- SDK runner RPC (slice 3) ----------

/**
 * SDK runner events as they flow back from the sidecar. The runner translates
 * Claude Code SDK message types into these — text deltas accumulate into a
 * single Block Node's content; tool_use / tool_result land as discrete Block
 * Nodes when complete; turn-complete fires once at the end.
 *
 * `block-complete` carries the full `BlockPayload` so the renderer (or the
 * sidecar's appendTurn fan-out) can persist the Block. `text-delta` is for
 * incremental UI rendering of an in-flight text block; the sidecar still
 * appends a single Block Node when the block completes.
 */
export const RunnerEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text-delta'),
    blockId: z.string(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('block-complete'),
    blockId: z.string(),
    /** The persisted Node id (when written through the Thread engine). */
    nodeId: z.string().optional(),
    payload: BlockPayloadSchema,
  }),
  z.object({
    kind: z.literal('turn-complete'),
    turnId: z.string(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
])
export type RunnerEvent = z.infer<typeof RunnerEventSchema>

export const SdkSendPromptInputSchema = z.object({
  workspaceId: z.string(),
  threadRootId: z.string(),
  prompt: z.string(),
  /** Absolute path to the repo Claude is allowed to read. */
  repoPath: z.string(),
})
export type SdkSendPromptInput = z.infer<typeof SdkSendPromptInputSchema>

export const SdkCancelInputSchema = z.object({
  threadRootId: z.string(),
})
export type SdkCancelInput = z.infer<typeof SdkCancelInputSchema>

export const SdkRecycleInputSchema = z.object({
  threadRootId: z.string(),
})
export type SdkRecycleInput = z.infer<typeof SdkRecycleInputSchema>

export const SdkSendPromptResultSchema = z.object({
  /** ID of the Turn Node that was written. */
  turnId: z.string(),
  /** Reason the run ended. `done` = SDK reported success; otherwise SDK error code. */
  reason: z.enum(['done', 'cancelled', 'error']),
})
export type SdkSendPromptResult = z.infer<typeof SdkSendPromptResultSchema>

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
  'thread.scanInterrupted': {
    input: ThreadScanInterruptedInputSchema,
    output: ThreadScanInterruptedOutputSchema,
  },
  'thread.branch': {
    input: ThreadBranchInputSchema,
    output: ThreadBranchOutputSchema,
  },
  'thread.retry': {
    input: ThreadRetryInputSchema,
    output: ThreadRetryOutputSchema,
  },
  'thread.newSibling': {
    input: ThreadNewSiblingInputSchema,
    output: ThreadNewSiblingOutputSchema,
  },
  // ---- Auth (slice 3) ----
  // Sidecar handlers are typically no-ops or delegate to its keychainStore;
  // the renderer-facing wire path goes via Tauri commands (`auth_set_api_key`,
  // `auth_has_api_key`, `auth_delete_api_key`) which own the OS keychain.
  // Listed here so the contract is the single source of truth for renderer
  // payload shapes — see `ipc.ts`.
  'auth.setApiKey': {
    input: AuthSetApiKeyInputSchema,
    output: z.object({ ok: z.literal(true) }),
  },
  'auth.hasApiKey': {
    input: z.object({}),
    output: AuthHasApiKeyOutputSchema,
  },
  'auth.deleteApiKey': {
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
  },
  // ---- SDK runner (slice 3) ----
  // `sdk.sendPrompt` is the streaming case. Its `output` schema describes the
  // FINAL result envelope (sent in the wire `ok` response); the streaming
  // events flow as discriminated `RunnerEventSchema` messages over a
  // separate stream-frame envelope. See `RpcResponseSchema` below.
  'sdk.sendPrompt': {
    input: SdkSendPromptInputSchema,
    output: SdkSendPromptResultSchema,
  },
  'sdk.cancel': {
    input: SdkCancelInputSchema,
    output: z.object({ ok: z.boolean() }),
  },
  'sdk.recycle': {
    input: SdkRecycleInputSchema,
    output: z.object({ ok: z.literal(true) }),
  },
  // Internal: Rust → sidecar push of the API key (one-way, no response). Not
  // callable from the renderer (Tauri's `rpc` invoke only round-trips through
  // the renderer-facing wire), so listing here documents the shape without
  // surfacing it to renderer code paths.
  'auth.injectApiKey': {
    input: z.object({ key: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  'auth.clearApiKey': {
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
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
  /**
   * Streaming wire frame (slice 3). For methods like `sdk.sendPrompt` the
   * sidecar emits zero or more `stream` frames followed by exactly one
   * terminal `ok` or `err` frame, all keyed to the same request `id`. The
   * Rust shell forwards stream frames to the renderer as Tauri events
   * (channel `rpc:stream:<id>`); the terminal ok/err is the resolution of
   * the original `invoke('rpc', ...)` promise.
   */
  z.object({ kind: z.literal('stream'), id: z.string(), event: RunnerEventSchema }),
])
export type RpcResponse = z.infer<typeof RpcResponseSchema>

/**
 * Sidecar → Rust shell out-of-band requests. Used by `sdk.sendPrompt` only
 * in the rare path where the sidecar needs to ask the shell for the API
 * key on demand (normally the shell pushes the key proactively via
 * `auth.injectApiKey`).
 *
 * Slice 3 doesn't currently exercise this — kept as a documented seam so
 * the wire envelope stays open for future sidecar-initiated calls.
 */
export const SidecarRequestSchema = z.object({
  kind: z.literal('sidecar-request'),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
})
export type SidecarRequest = z.infer<typeof SidecarRequestSchema>
