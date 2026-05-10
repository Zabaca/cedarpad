/**
 * Adapter from the Claude Agent SDK to the narrow `SdkClient` shape the
 * Thread engine + SDK runner consume.
 *
 * The SDK's `query()` and `forkSession()` live on the same module — we
 * wrap both so callers don't have to depend on the SDK's type surface
 * directly (cf. CLAUDE.md §7 — boundary parsing). Tests pass in scripted
 * fakes against the `SdkClient` interface.
 *
 * `forkSession` is invoked eagerly by `threadEngine.forkAtPrompt`
 * (Cmd+Shift+B) so every Branch carries a real, resumable session id at
 * creation time. The wrapper passes `upToMessageId` straight through —
 * which the SDK treats as the inclusive cut point.
 */
import {
  query as realQuery,
  forkSession as realForkSession,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  SdkClient,
  SdkQueryHandle,
  SdkQueryParams,
  SdkForkSessionOptions,
  SdkForkSessionResult,
} from './sdkRunner.ts'

export function createRealSdkClient(): SdkClient {
  return {
    query(params: SdkQueryParams): SdkQueryHandle {
      // The SDK accepts the same param shape we expose. Cast the prompt-
      // string (the runtime requires either string or AsyncIterable; both
      // are valid). The Query returned by the SDK already implements the
      // AsyncIterable + interrupt() contract.
      const handle = realQuery({
        prompt: params.prompt as string,
        // Cast away — our reduced Options shape is a strict subset of the
        // SDK's, but TS cannot prove it without re-importing 6KB of
        // ambient types.
        options: params.options as Parameters<typeof realQuery>[0]['options'],
      })
      return handle as unknown as SdkQueryHandle
    },
    async forkSession(
      sessionId: string,
      options?: SdkForkSessionOptions,
    ): Promise<SdkForkSessionResult> {
      // Pass-through to the SDK. `upToMessageId` is the inclusive cut
      // point. `dir` is left to the caller (the sidecar typically passes
      // the workspace's repo path so the SDK's session store finds the
      // source session file).
      const result = await realForkSession(sessionId, options)
      return { sessionId: result.sessionId }
    },
  }
}
