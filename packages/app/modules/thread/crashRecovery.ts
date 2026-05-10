/**
 * Crash recovery for Prompt Nodes (v1.1 Shape B).
 *
 * Premise: when the sidecar dies (app crash, force-quit, OS reboot)
 * while a Prompt is mid-stream, the on-disk Content Node remains
 * stamped `metadata.state: 'streaming'` — there's no way to flush a
 * "we're done" marker if the process just disappears. On next launch
 * the sidecar is fresh, no runner is driving any Prompt, so any Prompt
 * still in `streaming` is by definition orphaned.
 *
 * The scan walks every Content Node in the workspace, finds those with
 * `state === 'streaming'`, and transitions them to `state: 'interrupted'`.
 * The renderer surfaces `interrupted` with a different visual treatment
 * than `cancelled` so the user can tell "I asked Claude to stop" apart
 * from "the app crashed and this is partial garbage."
 *
 * Idempotent: calling scan twice in a row is a no-op the second time.
 */
import type { OutlineStore } from '../outline/outlineStore.ts'
import { createThreadEngine } from './threadEngine.ts'
import { PromptMetadataSchema } from '../../src/contract.ts'

export interface ScanInterruptedPromptsResult {
  interruptedPromptIds: string[]
}

/**
 * Walk every Content Node in the workspace and stamp any with
 * `metadata.state === 'streaming'` as `state: 'interrupted'`. Returns
 * the ids that were transitioned.
 *
 * We scan via DFS from the workspace roots so we don't need a separate
 * "list all prompts" query — the OutlineStore exposes only `getChildren`.
 */
export async function scanInterruptedPrompts(
  store: OutlineStore,
): Promise<ScanInterruptedPromptsResult> {
  const engine = createThreadEngine(store)
  const interruptedPromptIds: string[] = []

  async function visit(parentId: string | null): Promise<void> {
    const children = await store.getChildren(parentId)
    for (const child of children) {
      if (child.kind === 'content') {
        const parsed = PromptMetadataSchema.safeParse(child.metadata)
        if (parsed.success && parsed.data.state === 'streaming') {
          await engine.markPromptInterrupted(child.id)
          interruptedPromptIds.push(child.id)
        }
      }
      // Recurse unconditionally — Prompts can be nested under any
      // Content Node ancestry chain.
      await visit(child.id)
    }
  }

  await visit(null)
  return { interruptedPromptIds }
}
