/**
 * Integration-boundary tests for the SDK adapter (`createRealSdkClient`).
 *
 * The wrapper is a thin pass-through to the Claude Agent SDK's
 * `query()` + `forkSession()`. We mock the SDK module so we can assert
 * the wrapper:
 *   - forwards `upToMessageId` to `forkSession` verbatim
 *   - normalises the result to `{ sessionId }` (drops other SDK
 *     fields if any are added in the future)
 *
 * The runner's behaviour against the wider SdkClient surface is covered
 * by `sdkRunner.test.ts`; this file is the seam between our wrapper and
 * the SDK module itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(() => ({
      async interrupt() {},
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined as never }
          },
          async return() {
            return { done: true, value: undefined as never }
          },
        }
      },
    })),
    forkSession: vi.fn(async () => ({ sessionId: 'real-fork-sid' })),
  }
})

describe('createRealSdkClient.forkSession — wraps the SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes sessionId + upToMessageId through to the SDK and returns { sessionId }', async () => {
    const sdkModule = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      forkSession: ReturnType<typeof vi.fn>
    }
    const { createRealSdkClient } = await import('./sdkClient.ts')
    const client = createRealSdkClient()

    const result = await client.forkSession('source-sid', {
      upToMessageId: 'msg-uuid-1',
      dir: '/repo',
    })

    expect(sdkModule.forkSession).toHaveBeenCalledTimes(1)
    expect(sdkModule.forkSession).toHaveBeenCalledWith('source-sid', {
      upToMessageId: 'msg-uuid-1',
      dir: '/repo',
    })
    expect(result).toEqual({ sessionId: 'real-fork-sid' })
  })

  it('omits upToMessageId when caller did not provide one (full-history fork)', async () => {
    const sdkModule = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      forkSession: ReturnType<typeof vi.fn>
    }
    const { createRealSdkClient } = await import('./sdkClient.ts')
    const client = createRealSdkClient()

    await client.forkSession('source-sid', { dir: '/r' })

    expect(sdkModule.forkSession).toHaveBeenCalledWith('source-sid', { dir: '/r' })
  })
})
