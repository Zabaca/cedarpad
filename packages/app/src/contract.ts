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

// ---------- JSON column schemas ----------

/**
 * Open-ended for slice 1; closed once Turn/Block kinds land in slice 3+.
 */
export const NodeMetadataSchema = z.object({}).passthrough()
export type NodeMetadata = z.infer<typeof NodeMetadataSchema>

// ---------- Domain shapes ----------

export const NodeKindSchema = z.enum(['content'])
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

// ---------- Workspace RPC ----------

export const WorkspaceSummarySchema = z.object({
  id: z.string(),
  repoPath: z.string(),
  displayName: z.string(),
  dbPath: z.string(),
  lastOpenedAt: z.number(),
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
