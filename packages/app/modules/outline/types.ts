// Re-export the contract types so deep modules don't import from src/.
// Deep modules own the persistence layer; the contract owns the wire shape.
// They happen to coincide for slice 1 — keep the indirection so we can
// diverge later without ripple-touching every test.
export type {
  Node,
  NodeKind,
  NodeMetadata,
  BlockKind,
  BlockPayload,
  BlockMetadata,
  PromptMetadata,
  PromptState,
  SessionBearerMetadata,
  OutlineCreateInput,
  OutlineUpdateInput,
  OutlineMoveInput,
} from '../../src/contract.ts'
