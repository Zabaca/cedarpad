/**
 * Crash recovery for Turn Nodes (slice 4).
 *
 * Premise: when the sidecar dies (app crash, force-quit, OS reboot) while a
 * Turn is mid-stream, the on-disk Turn Node remains stamped `state: 'streaming'`
 * — there's no way to flush a "we're done" marker if the process just
 * disappears. On next launch the sidecar is fresh, no runner is driving any
 * Turn, so any Turn still in `streaming` is by definition orphaned.
 *
 * The scan walks every Turn Node in the workspace, finds those with
 * `state === 'streaming'`, and transitions them to `state: 'interrupted'`.
 * The renderer surfaces `interrupted` with a different visual treatment than
 * `cancelled` so the user can tell "I asked Claude to stop" apart from
 * "the app crashed and this is partial garbage."
 *
 * Idempotent: calling scan twice in a row is a no-op the second time.
 */
import type { OutlineStore } from '../outline/outlineStore.ts'
import { createThreadEngine } from './threadEngine.ts'
import { TurnMetadataSchema } from '../../src/contract.ts'

export interface ScanInterruptedResult {
  interruptedTurnIds: string[]
}

/**
 * Walk every Turn Node in the workspace and stamp any with
 * `state === 'streaming'` as `state: 'interrupted'`. Returns the ids that
 * were transitioned.
 *
 * We scan via DFS from the workspace roots so we don't need a separate
 * "list all turns" query — the OutlineStore exposes only `getChildren`.
 */
export async function scanInterruptedTurns(store: OutlineStore): Promise<ScanInterruptedResult> {
  const engine = createThreadEngine(store)
  const interruptedTurnIds: string[] = []

  async function visit(parentId: string | null): Promise<void> {
    const children = await store.getChildren(parentId)
    for (const child of children) {
      if (child.kind === 'turn') {
        const parsed = TurnMetadataSchema.safeParse(child.metadata)
        if (parsed.success && parsed.data.state === 'streaming') {
          await engine.markTurnInterrupted(child.id)
          interruptedTurnIds.push(child.id)
        }
      }
      // Even non-turn nodes can have descendants (Thread Roots host Turns,
      // Content Nodes can have arbitrary children). Recurse unconditionally.
      await visit(child.id)
    }
  }

  await visit(null)
  return { interruptedTurnIds }
}
