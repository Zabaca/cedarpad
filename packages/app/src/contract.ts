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

// ---------- Block / Prompt shapes (v1.1 Shape B) ----------

/**
 * The structured pieces of a Claude turn. Each Block Node carries one of
 * these as the canonical encoding of its payload via `nodes.metadata`.
 *
 * In Shape B (ADR-0006) Block Nodes are children of Prompts directly —
 * there is no Turn Node intermediate.
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
 * Lifecycle of a Prompt (ADR-0006):
 *   - `streaming`   — sendPrompt fired; SDK runner is producing blocks. If
 *                     the app is killed in this state, crash recovery on
 *                     next launch transitions it to `interrupted`.
 *   - `done`        — turn-complete fired naturally.
 *   - `cancelled`   — user fired sdk.cancel; intentional stop.
 *   - `interrupted` — runner was no longer alive when next launch saw a
 *                     `streaming` Prompt. Visually distinct from `cancelled`
 *                     so the user knows the partial output is not a real
 *                     Claude response.
 *
 * Absence of `state` indicates an unsent draft (a Content Node that has
 * not yet been sent as a Prompt).
 */
export const PromptStateSchema = z.enum(['streaming', 'done', 'cancelled', 'interrupted'])
export type PromptState = z.infer<typeof PromptStateSchema>

/**
 * Marker stored in metadata of a Content Node that has been sent as a
 * Prompt. Open-ended (`passthrough`) so a Content Node that's also a
 * session-bearer (the root-level "Or" case) can carry both Prompt and
 * session-bearer fields on the same metadata object.
 */
export const PromptMetadataSchema = z
  .object({
    state: PromptStateSchema.optional(),
    /**
     * Claude Agent SDK assistant-message uuid for this Prompt. Captured
     * from the SDK's `assistant` messages so a future "branch from this
     * Prompt" PR can pass `resumeSessionAt: sdkMessageUuid` to fork at
     * the exact boundary. Last-write-wins per Prompt: when an SDK turn
     * includes multiple assistant messages, the LAST one is the
     * resumeSessionAt boundary.
     */
    sdkMessageUuid: z.string().nullable().optional(),
  })
  .passthrough()
export type PromptMetadata = z.infer<typeof PromptMetadataSchema>

/**
 * Marker stored in metadata of a Content Node that carries a Claude SDK
 * session — i.e. a session-bearer. Open-ended so Prompt+session-bearer
 * can coexist on the same node (the root-level "Or" case).
 */
export const SessionBearerMetadataSchema = z
  .object({
    /**
     * Claude Agent SDK session id for this conversation (captured from
     * the SDK's `system.init` event on the first Prompt under the
     * bearer). Persisted so subsequent `sdk.query()` calls can pass
     * `resume: sdkSessionId` and the SDK replays prior conversation
     * history server-side. Null/absent until the first Prompt lands;
     * once set, sticks for the life of the bearer.
     */
    sdkSessionId: z.string().nullable().optional(),
  })
  .passthrough()
export type SessionBearerMetadata = z.infer<typeof SessionBearerMetadataSchema>

/** Marker stored in metadata of a Block Node — wraps its payload. */
export const BlockMetadataSchema = z.object({
  role: z.literal('block'),
  payload: BlockPayloadSchema,
})
export type BlockMetadata = z.infer<typeof BlockMetadataSchema>

// ---------- JSON column schemas ----------

/**
 * Open-ended union: Content Nodes carry arbitrary metadata (incl. the
 * Prompt + session-bearer markers above), Block Nodes carry the strict
 * BlockMetadata shape.
 *
 * We use `passthrough` rather than a strict discriminated union so legacy
 * rows (`metadata: {}`) keep parsing.
 */
export const NodeMetadataSchema = z.object({}).passthrough()
export type NodeMetadata = z.infer<typeof NodeMetadataSchema>

// ---------- Domain shapes ----------

export const NodeKindSchema = z.enum(['content', 'block', 'branches'])
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

// ---------- Thread RPC (v1.1 Shape B) ----------

/**
 * Crash recovery (slice 4 / v1.1). On launch the renderer asks the
 * sidecar to scan for any Prompt Content Nodes left in
 * `metadata.state: 'streaming'` (no live runner is driving them —
 * necessarily so, since the sidecar process is fresh) and stamp them
 * `state: 'interrupted'`. Returns the ids that were transitioned so the
 * UI can surface them.
 */
export const ThreadScanInterruptedInputSchema = z.object({
  workspaceId: z.string(),
})
export type ThreadScanInterruptedInput = z.infer<typeof ThreadScanInterruptedInputSchema>

export const ThreadScanInterruptedOutputSchema = z.object({
  interruptedPromptIds: z.array(z.string()),
})
export type ThreadScanInterruptedOutput = z.infer<typeof ThreadScanInterruptedOutputSchema>

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

/**
 * Authoritative auth-state probe (post-slice-3 fix). Three modes:
 *  - `subscription` — Claude Code OAuth login is active (or ANTHROPIC_API_KEY
 *    is already set in the environment). The renderer skips the AuthPrompt
 *    and the SDK runner does NOT inject a key — the SDK reads the user's
 *    credentials file directly.
 *  - `api-key`      — no subscription, but a BYOK key is stored in our
 *    keychain. Renderer skips the AuthPrompt; runner injects the key.
 *  - `none`         — neither path is configured. Renderer shows the
 *    AuthPrompt with subscription-first messaging and BYOK as fallback.
 */
export const AuthModeSchema = z.enum(['subscription', 'api-key', 'none'])
export type AuthMode = z.infer<typeof AuthModeSchema>

export const AuthDetectOutputSchema = z.object({
  mode: AuthModeSchema,
  detail: z.string().optional(),
})
export type AuthDetectOutput = z.infer<typeof AuthDetectOutputSchema>

// ---------- SDK runner RPC (v1.1 Shape B) ----------

/**
 * SDK runner events as they flow back from the sidecar. The runner translates
 * Claude Code SDK message types into these — text deltas accumulate into a
 * single Block Node's content; tool_use / tool_result land as discrete Block
 * Nodes when complete; prompt-complete fires once at the end.
 *
 * `block-complete` carries the full `BlockPayload` so the renderer can
 * persist the Block. `text-delta` is for incremental UI rendering of an
 * in-flight text block; the sidecar still appends a single Block Node
 * when the block completes.
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
    kind: z.literal('prompt-complete'),
    promptId: z.string(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
])
export type RunnerEvent = z.infer<typeof RunnerEventSchema>

/**
 * Streaming send. The Prompt is the focused Content Node (its parent
 * carries `sdkSessionId` — the renderer ensures that before this call).
 * Block children of the Prompt are written as the SDK streams them.
 */
export const SdkSendPromptInputSchema = z.object({
  workspaceId: z.string(),
  promptNodeId: z.string(),
  prompt: z.string(),
  /** Absolute path to the repo Claude is allowed to read. */
  repoPath: z.string(),
})
export type SdkSendPromptInput = z.infer<typeof SdkSendPromptInputSchema>

export const SdkCancelInputSchema = z.object({
  promptNodeId: z.string(),
})
export type SdkCancelInput = z.infer<typeof SdkCancelInputSchema>

export const SdkRecycleInputSchema = z.object({
  promptNodeId: z.string(),
})
export type SdkRecycleInput = z.infer<typeof SdkRecycleInputSchema>

export const SdkSendPromptResultSchema = z.object({
  /** ID of the Prompt Node whose Block children were written. */
  promptId: z.string(),
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
  'thread.scanInterrupted': {
    input: ThreadScanInterruptedInputSchema,
    output: ThreadScanInterruptedOutputSchema,
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
  'auth.detect': {
    input: z.object({}),
    output: AuthDetectOutputSchema,
  },
  // Test-only seam for the WebView e2e harness — flips the forced auth
  // mode mid-session. Only effective when `CEDARPAD_E2E_AUTH_MODE` was
  // set at launch; production calls reject. Pass `mode: null` to clear.
  'auth.setE2EOverride': {
    input: z.object({ mode: AuthModeSchema.nullable() }),
    output: z.object({ ok: z.literal(true) }),
  },
  // ---- SDK runner ----
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
