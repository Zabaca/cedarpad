/**
 * Claude Code SDK runner (v1.1 Shape B).
 *
 * Wraps the Claude Agent SDK's `query()` async generator and translates
 * its messages into Block Nodes via the Thread engine. Each `sendPrompt`
 * call runs one Claude turn for a given Prompt Node — Block children
 * are written DIRECTLY under the Prompt (no Turn Node intermediate).
 * The runner emits a stream of {@link RunnerEvent}s
 * (text-delta / block-complete / prompt-complete / error).
 *
 * The SDK is configured with a hard read-only allowlist: `Read`, `Grep`,
 * `Glob`. This is enforced at the SDK boundary via the `tools` and
 * `allowedTools` options — Claude Code's `query()` will refuse to invoke
 * any tool not in the explicit `tools` list, regardless of model output.
 *
 * Process recycling (per ADR-0004): one Query handle exists per Prompt
 * at a time. `recycle(promptId)` aborts the current handle (if any) and
 * lets the next `sendPrompt` start a fresh one. The Outline state is
 * unaffected — recycle is a process-level reset, not a data reset.
 *
 * The SDK is injected (`SdkClient`) so unit tests can replay scripted
 * sequences. The production wiring lives in `src-sidecar/src/handlers.ts`.
 */
import { randomUUID } from 'node:crypto'
import type { ThreadEngine } from '../thread/threadEngine.ts'
import type { KeychainStore } from '../auth/keychainStore.ts'
import type { AuthMode } from '../auth/authProbe.ts'
import type { BlockPayload } from '../outline/types.ts'

/**
 * Wire-shape compatible with the claude-agent-sdk runtime, but reduced to
 * the fields we actually consume. Keeping this narrow lets unit tests
 * mock the SDK without re-importing the whole `BetaMessage` graph from
 * `@anthropic-ai/sdk`.
 */
export type SdkInputMessage =
  | {
      type: 'assistant'
      uuid?: string
      message: {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
          // Other content block types (thinking, etc.) are passed through but
          // ignored by the runner; we only persist text + tool_use.
          | { type: string; [k: string]: unknown }
        >
      }
    }
  | {
      type: 'user'
      message: {
        content:
          | string
          | Array<
              | {
                  type: 'tool_result'
                  tool_use_id: string
                  content: unknown
                  is_error?: boolean
                }
              | { type: string; [k: string]: unknown }
            >
      }
    }
  | {
      type: 'stream_event'
      event:
        | {
            type: 'content_block_start'
            index: number
            content_block: { type: string; [k: string]: unknown }
          }
        | {
            type: 'content_block_delta'
            index: number
            delta: { type: string; text?: string; [k: string]: unknown }
          }
        | { type: string; [k: string]: unknown }
    }
  | { type: 'result'; subtype: string; is_error?: boolean }
  | { type: 'system'; subtype: string; session_id?: string }
  | { type: string; [k: string]: unknown }

export interface SdkQueryParams {
  prompt: string | AsyncIterable<unknown>
  options?: {
    abortController?: AbortController
    cwd?: string
    allowedTools?: string[]
    tools?: string[] | { type: 'preset'; preset: 'claude_code' }
    env?: Record<string, string | undefined>
    permissionMode?: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan'
    [k: string]: unknown
  }
}

export interface SdkQueryHandle extends AsyncIterable<unknown> {
  /** Interrupt an in-flight query. */
  interrupt(): Promise<void>
}

/**
 * Options accepted by the `forkSession` adapter — thin pass-through of
 * the Claude Agent SDK's `ForkSessionOptions`. We only consume
 * `upToMessageId` (the inclusive cut point) directly; the rest are
 * surfaced for future use without forcing a re-export here.
 */
export interface SdkForkSessionOptions {
  /** Inclusive cut point. Omit to fork the entire session. */
  upToMessageId?: string
  /** Project directory for the SDK's session-store lookup. */
  dir?: string
  /** Title override for the forked session. */
  title?: string
}

export interface SdkForkSessionResult {
  /** UUID of the new forked session. Resumable via `resume`. */
  sessionId: string
}

/**
 * Slim adapter over the Claude Agent SDK. The production binding is
 * `realSdkClient()` (in `src-sidecar/src/sdkClient.ts`); tests pass in a
 * scripted fake.
 */
export interface SdkClient {
  query(params: SdkQueryParams): SdkQueryHandle
  /**
   * Wrap the SDK's `forkSession`. Called eagerly by
   * `threadEngine.forkAtPrompt` so a freshly-created Branch always
   * carries a real, resumable session id.
   */
  forkSession(sessionId: string, options?: SdkForkSessionOptions): Promise<SdkForkSessionResult>
}

export type RunnerEvent =
  | { kind: 'text-delta'; blockId: string; content: string }
  | { kind: 'block-complete'; blockId: string; nodeId?: string; payload: BlockPayload }
  | { kind: 'prompt-complete'; promptId: string }
  | { kind: 'error'; code: string; message: string }

export interface SendPromptInput {
  /** Id of the Prompt Content Node. Block children land under it. */
  threadId: string
  prompt: string
  repoPath: string
  /** Optional caller-controlled abort. Rare — `cancel(promptId)` is the normal path. */
  abortSignal?: AbortSignal
}

export interface SdkRunner {
  sendPrompt(input: SendPromptInput): AsyncIterable<RunnerEvent>
  cancel(promptId: string): Promise<void>
  recycle(promptId: string): Promise<void>
}

/** Tools that are allowed during slice 3. Read-only is the v1 commitment. */
export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const

interface ActiveRun {
  abortController: AbortController
  handle: SdkQueryHandle
  promptId: string
  cancelled: boolean
}

export interface CreateSdkRunnerOptions {
  sdk: SdkClient
  threadEngine: ThreadEngine
  keychain: KeychainStore
  /**
   * Returns the current auth mode. Called fresh on every `sendPrompt` so
   * the runner can react to auth changes (e.g. user just entered a BYOK
   * key after launching with no auth) without being recreated. If
   * omitted, the runner falls back to the slice-3 behaviour: require a
   * key in the keychain.
   */
  getAuthMode?: () => AuthMode
}

export function createSdkRunner({
  sdk,
  threadEngine,
  keychain,
  getAuthMode,
}: CreateSdkRunnerOptions): SdkRunner {
  const active = new Map<string, ActiveRun>()

  return {
    sendPrompt(input) {
      const { threadId: promptId, prompt, repoPath } = input
      // We can't return an AsyncGenerator directly from the outer arrow
      // because we need access to the runner state in `cancel()`; build
      // the generator inline.
      async function* run(): AsyncGenerator<RunnerEvent, void, unknown> {
        const mode: AuthMode = getAuthMode
          ? getAuthMode()
          : keychain.hasApiKey()
            ? 'api-key'
            : 'none'

        if (mode === 'none') {
          yield {
            kind: 'error',
            code: 'NO_AUTH',
            message: 'No Claude auth available. Sign in with `claude /login` or set an API key.',
          }
          return
        }

        // Only inject the BYOK key when we're actually in api-key mode.
        // In subscription mode the SDK reads its own credentials file
        // (or honours an existing `ANTHROPIC_API_KEY` env var) — adding
        // ours on top would be wrong for users who have a working
        // OAuth login but no BYOK key in our keychain.
        let apiKey: string | null = null
        if (mode === 'api-key') {
          apiKey = keychain.getApiKey()
          if (!apiKey) {
            yield {
              kind: 'error',
              code: 'NO_API_KEY',
              message: 'No Anthropic API key configured. Use auth.setApiKey first.',
            }
            return
          }
        }

        // Resume the SDK session if we've captured one for this Prompt's
        // session-bearer ancestor on a prior turn. Without `resume`,
        // every `sdk.query()` call is a fresh session and Claude has no
        // recollection of prior prompts — that's the bug PR #27 fixed.
        const sdkSessionId = await threadEngine.getSessionBearerSdkSessionId(promptId)

        const abortController = new AbortController()
        let handle: SdkQueryHandle
        try {
          // In subscription mode we hand `process.env` through unchanged
          // (no `ANTHROPIC_API_KEY` injection) so the SDK falls through
          // to its credentials file / keychain auth path.
          const env: Record<string, string | undefined> = { ...process.env }
          if (apiKey) env.ANTHROPIC_API_KEY = apiKey

          const queryOptions: SdkQueryParams['options'] = {
            abortController,
            cwd: repoPath,
            // Restrict to read-only tools at the SDK boundary. `tools`
            // restricts WHICH built-in tools the model can see;
            // `allowedTools` auto-approves them so we don't hit a
            // permission prompt the sidecar can't answer. Anything not
            // in `tools` is removed from the model's context entirely.
            tools: [...ALLOWED_TOOLS],
            allowedTools: [...ALLOWED_TOOLS],
            permissionMode: 'default',
            env,
          }
          if (sdkSessionId) queryOptions.resume = sdkSessionId

          handle = sdk.query({
            prompt,
            options: queryOptions,
          })
        } catch (err) {
          yield {
            kind: 'error',
            code: 'SDK_INIT_FAILED',
            message: err instanceof Error ? err.message : String(err),
          }
          return
        }

        const run: ActiveRun = { abortController, handle, promptId, cancelled: false }
        active.set(promptId, run)

        // In-flight text block state: when `stream_event` deltas arrive
        // before the wrapping `assistant` message lands, we accumulate
        // the deltas under one synthetic blockId. When the final
        // `assistant` text block arrives we use that text as the
        // canonical content and emit `block-complete` against the same
        // blockId so the renderer can reconcile.
        let inFlightTextBlockId: string | null = null

        try {
          for await (const raw of handle) {
            if (run.cancelled) break
            const msg = raw as SdkInputMessage
            if (typeof msg !== 'object' || msg === null) continue

            switch (msg.type) {
              case 'system': {
                // The SDK emits `subtype: 'init'` once per query with a
                // `session_id`. On the FIRST turn for this Prompt's
                // bearer we persist it onto the bearer so subsequent
                // turns can pass `resume: sessionId` and the SDK
                // replays history server-side. On resumed turns the SDK
                // still emits `init` with the same `session_id` we
                // passed in via `resume` — re-stamping it is a no-op
                // for correctness, but we skip the DB write when we
                // already had it cached via `sdkSessionId`.
                if (
                  msg.subtype === 'init' &&
                  !sdkSessionId &&
                  typeof msg.session_id === 'string' &&
                  msg.session_id.length > 0
                ) {
                  await threadEngine.setSessionBearerSdkSessionId(promptId, msg.session_id)
                }
                break
              }
              case 'stream_event': {
                const ev = msg.event
                if (!ev || typeof ev !== 'object') break
                if (ev.type === 'content_block_start') {
                  const cb = (ev as { content_block?: { type?: string } }).content_block
                  if (cb && cb.type === 'text') {
                    inFlightTextBlockId = `blk_${randomUUID()}`
                  }
                } else if (ev.type === 'content_block_delta') {
                  const delta = (ev as { delta?: { type?: string; text?: string } }).delta
                  if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
                    if (!inFlightTextBlockId) {
                      inFlightTextBlockId = `blk_${randomUUID()}`
                    }
                    yield {
                      kind: 'text-delta',
                      blockId: inFlightTextBlockId,
                      content: delta.text,
                    }
                  }
                }
                break
              }
              case 'assistant': {
                // Stamp the SDK assistant-message uuid onto the Prompt.
                // Last-write-wins: when an SDK turn includes multiple
                // assistant messages (e.g. text → tool_use → text after
                // tool_result), `resumeSessionAt` for "branch from this
                // Prompt" wants the LAST assistant message of the Prompt
                // so the resumed history includes the full turn.
                const assistantUuid = (msg as { uuid?: unknown }).uuid
                if (typeof assistantUuid === 'string' && assistantUuid.length > 0) {
                  await threadEngine.setPromptSdkMessageUuid(promptId, assistantUuid)
                }
                const blocks = msg.message?.content ?? []
                for (const block of blocks) {
                  if (run.cancelled) break
                  if (block.type === 'text') {
                    const text = String((block as { text?: unknown }).text ?? '')
                    const blockId = inFlightTextBlockId ?? `blk_${randomUUID()}`
                    const payload: BlockPayload = { kind: 'text', text }
                    const node = await threadEngine.appendBlock(promptId, payload)
                    yield {
                      kind: 'block-complete',
                      blockId,
                      nodeId: node.id,
                      payload,
                    }
                    inFlightTextBlockId = null
                  } else if (block.type === 'tool_use') {
                    const tu = block as { id?: string; name?: string; input?: unknown }
                    const payload: BlockPayload = {
                      kind: 'tool_use',
                      toolName: String(tu.name ?? ''),
                      toolUseId: tu.id ? String(tu.id) : undefined,
                      input: tu.input,
                    }
                    const node = await threadEngine.appendBlock(promptId, payload)
                    yield {
                      kind: 'block-complete',
                      blockId: `blk_${node.id}`,
                      nodeId: node.id,
                      payload,
                    }
                  }
                  // other content block types (thinking, etc.) are dropped.
                }
                break
              }
              case 'user': {
                const content = msg.message?.content
                if (Array.isArray(content)) {
                  for (const block of content) {
                    if (run.cancelled) break
                    if (block.type === 'tool_result') {
                      const tr = block as {
                        tool_use_id?: string
                        content?: unknown
                        is_error?: boolean
                      }
                      const payload: BlockPayload = {
                        kind: 'tool_result',
                        toolUseId: tr.tool_use_id ? String(tr.tool_use_id) : undefined,
                        output: tr.content,
                        isError: tr.is_error,
                      }
                      const node = await threadEngine.appendBlock(promptId, payload)
                      yield {
                        kind: 'block-complete',
                        blockId: `blk_${node.id}`,
                        nodeId: node.id,
                        payload,
                      }
                    }
                  }
                }
                break
              }
              case 'result': {
                if (msg.subtype && msg.subtype !== 'success') {
                  yield {
                    kind: 'error',
                    code: msg.subtype,
                    message: `SDK reported ${msg.subtype}`,
                  }
                }
                break
              }
              default:
                break
            }
          }
        } catch (err) {
          if (!run.cancelled) {
            yield {
              kind: 'error',
              code: 'SDK_RUNTIME',
              message: err instanceof Error ? err.message : String(err),
            }
          }
        } finally {
          if (active.get(promptId) === run) active.delete(promptId)
        }

        if (run.cancelled) {
          await threadEngine.markPromptCancelled(promptId)
          // Don't emit a prompt-complete on cancel — the consumer asked us to
          // stop. The cancellation is observable via the Prompt's metadata.
        } else {
          await threadEngine.markPromptDone(promptId)
          yield { kind: 'prompt-complete', promptId }
        }
      }

      return run()
    },

    async cancel(promptId) {
      const run = active.get(promptId)
      if (!run) return
      run.cancelled = true
      run.abortController.abort()
      try {
        await run.handle.interrupt()
      } catch {
        // interrupt is best-effort; the cancellation flag drives correctness.
      }
    },

    async recycle(promptId) {
      // Tear down any in-flight handle; the next sendPrompt will start a
      // fresh one. Outline state is untouched — recycle is process-level.
      const run = active.get(promptId)
      if (run) {
        run.cancelled = true
        run.abortController.abort()
        try {
          await run.handle.interrupt()
        } catch {
          // ignore
        }
        active.delete(promptId)
      }
    },
  }
}
