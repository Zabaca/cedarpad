/**
 * Sidecar RPC handlers. Wired to deep modules (outlineStore, workspaceManager).
 *
 * Validation lives in `server.ts` — handlers receive already-parsed input and
 * return values that will be re-validated against the contract output schema.
 */
import type { MethodName, MethodInput, MethodOutput } from '../../src/contract.ts'

export type Handler<M extends MethodName> = (input: MethodInput<M>) => Promise<MethodOutput<M>> | MethodOutput<M>

export type Handlers = { [M in MethodName]?: Handler<M> }

// Slice 1 wires these in lazily as modules come online. Step 1 only needs ping.
export const handlers: Handlers = {
  ping: ({ msg }) => ({ pong: true, echo: msg }),
}
