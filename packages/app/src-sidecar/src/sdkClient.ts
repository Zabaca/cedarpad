/**
 * Production binding between the sidecar and the Claude Agent SDK.
 *
 * The sidecar imports `query` from `@anthropic-ai/claude-agent-sdk` and
 * adapts it to the narrow `SdkClient` shape the runner consumes. We wrap
 * the SDK rather than typing against it directly so unit tests can swap
 * in scripted fakes (see `modules/sdk/sdkRunner.test.ts`).
 *
 * E2E mode: when `CEDARPAD_E2E_FAKE_SDK=1`, we substitute a deterministic
 * fake that emits a known turn (one text, one tool_use, one tool_result,
 * one text) regardless of the prompt. This lets the WebView e2e drive
 * the full sdk.sendPrompt → block streaming → tree render path without
 * needing a real Claude API key or making network calls.
 */
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk'
import type { SdkClient, SdkQueryHandle, SdkQueryParams } from '../../modules/sdk/sdkRunner.ts'

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
  }
}

/**
 * Deterministic fake for the WebView e2e. Emits a fixed message sequence
 * matching one Claude turn against a Read tool. Ignores the prompt
 * content.
 */
export function createE2EFakeSdkClient(): SdkClient {
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
  }
}

export function chooseSdkClient(): SdkClient {
  if (process.env.CEDARPAD_E2E_FAKE_SDK === '1') {
    return createE2EFakeSdkClient()
  }
  return createRealSdkClient()
}
