/**
 * Sidecar RPC handlers. Wired to the deep modules.
 *
 * Validation lives in `server.ts` (it parses input/output via the schemas in
 * `src/contract.ts`); handlers receive already-typed input and return values
 * that get re-validated against the contract output schema before going on
 * the wire. No ad-hoc per-handler validation here — the contract is the
 * single source of truth.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { MethodName, MethodInput, MethodOutput, Node, RunnerEvent } from '../../src/contract.ts'
import { createWorkspaceManager, type WorkspaceManager } from '../../modules/workspace/workspaceManager.ts'
import { createOutlineStore, type OutlineStore } from '../../modules/outline/outlineStore.ts'
import { createThreadEngine, type ThreadEngine } from '../../modules/thread/threadEngine.ts'
import type { DbClient } from '../../modules/db/libsqlClient.ts'
import { createKeychainStore, type KeychainStore } from '../../modules/auth/keychainStore.ts'
import { createSdkRunner, type SdkRunner } from '../../modules/sdk/sdkRunner.ts'
import { chooseSdkClient } from './sdkClient.ts'

export type Handler<M extends MethodName> = (input: MethodInput<M>) => Promise<MethodOutput<M>> | MethodOutput<M>

export type Handlers = { [M in MethodName]?: Handler<M> }

// Globals — sidecar is a single-process owner of the DB. One workspace
// manager, lazily-created outline stores per workspace id.
const globalDir = process.env.CEDARPAD_GLOBAL_DIR ?? join(homedir(), '.cedarpad')
mkdirSync(globalDir, { recursive: true })
const recentsDbUrl = `file:${join(globalDir, 'global.db')}`

let wm: WorkspaceManager | null = null
const outlineStores = new Map<string, OutlineStore>()
const threadEngines = new Map<string, ThreadEngine>()

// Auth: the keychain store holds the API key in memory after Rust pushes
// it via auth.injectApiKey. The OS keychain itself lives in the Rust shell.
const keychain: KeychainStore = createKeychainStore()

// SDK runners — one per workspace, since each runner closes over the
// workspace's Thread engine (which writes Block Nodes to that workspace's
// libSQL DB). The SdkClient itself is shared.
const sdkClient = chooseSdkClient()
const sdkRunners = new Map<string, SdkRunner>()

async function getRunner(workspaceId: string): Promise<SdkRunner> {
  const cached = sdkRunners.get(workspaceId)
  if (cached) return cached
  const engine = await getThread(workspaceId)
  const runner = createSdkRunner({ sdk: sdkClient, threadEngine: engine, keychain })
  sdkRunners.set(workspaceId, runner)
  return runner
}

/** Public surface for the streaming dispatch in server.ts. */
export function getSdkRunnerForWorkspace(workspaceId: string): Promise<SdkRunner> {
  return getRunner(workspaceId)
}

export function getKeychain(): KeychainStore {
  return keychain
}

function getWm(): WorkspaceManager {
  if (!wm) wm = createWorkspaceManager({ recentsDbUrl, recentLimit: 10 })
  return wm
}

async function getOutline(workspaceId: string): Promise<OutlineStore> {
  const cached = outlineStores.get(workspaceId)
  if (cached) return cached
  const db: DbClient = await getWm().outlineDb(workspaceId)
  const store = createOutlineStore(db)
  outlineStores.set(workspaceId, store)
  return store
}

async function getThread(workspaceId: string): Promise<ThreadEngine> {
  const cached = threadEngines.get(workspaceId)
  if (cached) return cached
  const store = await getOutline(workspaceId)
  const engine = createThreadEngine(store)
  threadEngines.set(workspaceId, engine)
  return engine
}

function nodeOut(node: Node): Node {
  return node
}

export const handlers: Handlers = {
  ping: ({ msg }) => ({ pong: true, echo: msg }),

  'workspace.open': async ({ repoPath }) => {
    const summary = await getWm().open(repoPath)
    return summary
  },
  'workspace.switch': async ({ id }) => {
    const summary = await getWm().switch(id)
    return summary
  },
  'workspace.recent': async () => {
    return getWm().recent()
  },
  'workspace.active': async () => {
    return getWm().active()
  },
  'workspace.setActiveNode': async ({ id, activeNodeId }) => {
    return getWm().setActiveNode(id, activeNodeId)
  },

  'outline.create': async ({ workspaceId, parentId, prevSiblingId, content, metadata }) => {
    const store = await getOutline(workspaceId)
    return nodeOut(await store.createNode({ parentId, prevSiblingId: prevSiblingId ?? null, content, metadata }))
  },
  'outline.get': async ({ workspaceId, id }) => {
    const store = await getOutline(workspaceId)
    return store.getNode(id)
  },
  'outline.update': async ({ workspaceId, id, content, completed, metadata }) => {
    const store = await getOutline(workspaceId)
    return nodeOut(await store.updateNode({ id, content, completed, metadata }))
  },
  'outline.move': async ({ workspaceId, id, newParentId, prevSiblingId }) => {
    const store = await getOutline(workspaceId)
    return nodeOut(await store.moveNode({ id, newParentId, prevSiblingId: prevSiblingId ?? null }))
  },
  'outline.delete': async ({ workspaceId, id }) => {
    const store = await getOutline(workspaceId)
    return store.deleteNode(id)
  },
  'outline.getChildren': async ({ workspaceId, parentId }) => {
    const store = await getOutline(workspaceId)
    return store.getChildren(parentId)
  },
  'outline.search': async ({ workspaceId, query }) => {
    const store = await getOutline(workspaceId)
    return store.searchNodes(query)
  },

  'thread.start': async ({ workspaceId, rootNodeId }) => {
    const engine = await getThread(workspaceId)
    return nodeOut(await engine.startThread(rootNodeId))
  },
  'thread.appendPrompt': async ({ workspaceId, threadRootId, content }) => {
    const engine = await getThread(workspaceId)
    return nodeOut(await engine.appendPrompt(threadRootId, content))
  },
  'thread.appendTurn': async ({ workspaceId, threadRootId, blocks }) => {
    const engine = await getThread(workspaceId)
    const result = await engine.appendTurn(threadRootId, blocks)
    return { turn: nodeOut(result.turn), blocks: result.blocks.map(nodeOut) }
  },

  // ---- Auth (slice 3) ----
  // The renderer-facing auth methods (auth.setApiKey/hasApiKey/deleteApiKey)
  // are owned by the Rust shell and the OS keychain — they don't reach the
  // sidecar. The two methods below are sidecar-internal: Rust pushes the
  // key in/out via these messages.
  'auth.injectApiKey': ({ key }) => {
    keychain.setApiKey(key)
    return { ok: true } as const
  },
  'auth.clearApiKey': () => {
    keychain.deleteApiKey()
    return { ok: true } as const
  },
  // Defensive renderer-callable handlers. In the production wiring the
  // renderer's auth.* calls go through Tauri commands, NOT through this
  // sidecar — but the contract is one source of truth and the registry
  // requires every method have a handler. These return the sidecar's
  // local view of state (which mirrors Rust's via the inject path).
  'auth.hasApiKey': () => ({ hasKey: keychain.hasApiKey() }),
  'auth.setApiKey': ({ key }) => {
    keychain.setApiKey(key)
    return { ok: true } as const
  },
  'auth.deleteApiKey': () => {
    keychain.deleteApiKey()
    return { ok: true } as const
  },

  // ---- SDK runner (slice 3) ----
  // Note: `sdk.sendPrompt` is the streaming case and is dispatched by
  // `server.ts` directly — it does not appear in this registry, because
  // its return value is an event stream, not a plain promise.
  'sdk.cancel': async ({ threadRootId }) => {
    // Cancellation is fire-and-forget: it only matters if a runner exists
    // for the active workspace, but we don't know the workspaceId from
    // this payload alone. Walk every runner and cancel the matching
    // threadRootId on each — at most one will be in flight in v1 (single
    // active workspace).
    for (const runner of sdkRunners.values()) {
      await runner.cancel(threadRootId)
    }
    return { ok: true }
  },
  'sdk.recycle': async ({ threadRootId }) => {
    for (const runner of sdkRunners.values()) {
      await runner.recycle(threadRootId)
    }
    return { ok: true } as const
  },
}
