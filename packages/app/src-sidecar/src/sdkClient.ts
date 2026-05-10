/**
 * Sidecar binding to the SDK adapter. The real wrapper lives in
 * `modules/sdk/sdkClient.ts` so it's importable from non-sidecar code
 * (e.g. tests). This file's job is the E2E fake + the `chooseSdkClient`
 * gate.
 *
 * E2E mode: when `CEDARPAD_E2E_FAKE_SDK=1`, we substitute a deterministic
 * fake that emits a known turn (one text, one tool_use, one tool_result,
 * one text) regardless of the prompt. This lets the WebView e2e drive
 * the full sdk.sendPrompt → block streaming → tree render path without
 * needing a real Claude API key or making network calls.
 *
 * The fake `forkSession` returns a deterministic, prefix-stable session id
 * (`fork-of-<sourceSessionId>` or `forked-<n>` if the source is empty) so
 * branch specs can assert "the new Branch carries a different session id
 * from the source bearer" without coupling to runtime UUIDs.
 */
import { createRealSdkClient } from '../../modules/sdk/sdkClient.ts'
import type {
  SdkClient,
  SdkQueryHandle,
  SdkQueryParams,
  SdkForkSessionOptions,
  SdkForkSessionResult,
} from '../../modules/sdk/sdkRunner.ts'

/**
 * Deterministic fake for the WebView e2e. Emits a fixed message sequence
 * matching one Claude turn against a Read tool. Ignores the prompt
 * content. `forkSession` returns a predictable session id derived from
 * the source so branch specs stay deterministic.
 */
export function createE2EFakeSdkClient(): SdkClient {
  let forkCounter = 0
  return {
    query(_params: SdkQueryParams): SdkQueryHandle {
      const script: unknown[] = [
        { type: 'system', subtype: 'init' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Looking at README' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'README.md' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'cedarpad outliner' }],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'It is the cedarpad outliner.' }] },
        },
        { type: 'result', subtype: 'success' },
      ]
      let cancelled = false
      return {
        async interrupt() {
          cancelled = true
        },
        [Symbol.asyncIterator]() {
          let i = 0
          return {
            async next() {
              if (cancelled) return { done: true, value: undefined as never }
              if (i >= script.length) return { done: true, value: undefined as never }
              // Slight delay so the renderer can observe streaming.
              await new Promise((r) => setTimeout(r, 20))
              if (cancelled) return { done: true, value: undefined as never }
              const v = script[i++]
              return { done: false, value: v }
            },
            async return() {
              cancelled = true
              return { done: true, value: undefined as never }
            },
          }
        },
      }
    },
    async forkSession(
      sessionId: string,
      _options?: SdkForkSessionOptions,
    ): Promise<SdkForkSessionResult> {
      forkCounter += 1
      const sid = sessionId.length > 0 ? `fork-of-${sessionId}-${forkCounter}` : `forked-${forkCounter}`
      return { sessionId: sid }
    },
  }
}

export function chooseSdkClient(): SdkClient {
  if (process.env.CEDARPAD_E2E_FAKE_SDK === '1') {
    return createE2EFakeSdkClient()
  }
  return createRealSdkClient()
}

// Re-export for callers that imported from the sidecar module name.
export { createRealSdkClient }
