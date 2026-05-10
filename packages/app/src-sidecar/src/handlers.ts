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
import type { MethodName, MethodInput, MethodOutput, Node } from '../../src/contract.ts'
import { createWorkspaceManager, type WorkspaceManager } from '../../modules/workspace/workspaceManager.ts'
import { createOutlineStore, type OutlineStore } from '../../modules/outline/outlineStore.ts'
import { createThreadEngine, type ThreadEngine } from '../../modules/thread/threadEngine.ts'
import type { DbClient } from '../../modules/db/libsqlClient.ts'

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
}
