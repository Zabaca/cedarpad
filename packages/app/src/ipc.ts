/**
 * Renderer-side IPC. Validates outgoing input + incoming output against the
 * shared `contract.ts` schemas, so an out-of-spec request never leaves the
 * renderer and an out-of-spec response never reaches the rest of the app.
 *
 * In dev outside Tauri (browser-only `vite dev`), we fall back to a "browser
 * mode" stub that throws — the renderer guards on `window.__TAURI__` before
 * issuing IPC.
 */
import {
  Methods,
  RunnerEventSchema,
  type MethodName,
  type MethodInput,
  type MethodOutput,
  type RunnerEvent,
} from './contract'

declare global {
  interface Window {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && (window.__TAURI__ != null || window.__TAURI_INTERNALS__ != null)
}

async function rawInvoke(method: string, params: unknown): Promise<unknown> {
  if (!isTauri()) {
    throw new Error(
      `IPC unavailable: not running inside Tauri (method=${method}). Use \`bun tauri dev\`.`,
    )
  }
  // Lazy-import so vitest/non-Tauri environments don't choke on the module.
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke('rpc', { method, params })
}

export async function call<M extends MethodName>(method: M, params: MethodInput<M>): Promise<MethodOutput<M>> {
  const spec = Methods[method]
  const inputParse = spec.input.safeParse(params)
  if (!inputParse.success) {
    throw new Error(`bad input for ${method}: ${inputParse.error.message}`)
  }
  const raw = await rawInvoke(method, inputParse.data)
  const outputParse = spec.output.safeParse(raw)
  if (!outputParse.success) {
    throw new Error(`bad response for ${method}: ${outputParse.error.message}`)
  }
  return outputParse.data as MethodOutput<M>
}

// ---------- Auth (slice 3) ----------
//
// Auth methods don't go through the `rpc` invoke channel — they're owned
// by the Rust shell directly so the renderer can never see the key on
// the way back. The renderer calls dedicated Tauri commands via
// `__TAURI_INTERNALS__.invoke`.
async function tauriCommand(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!isTauri()) {
    throw new Error(`Tauri unavailable: ${cmd} requires the desktop shell`)
  }
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke(cmd, args)
}

export async function authSetApiKey(key: string): Promise<void> {
  await tauriCommand('auth_set_api_key', { key })
}

export async function authHasApiKey(): Promise<boolean> {
  const out = await tauriCommand('auth_has_api_key')
  return Boolean(out)
}

export async function authDeleteApiKey(): Promise<void> {
  await tauriCommand('auth_delete_api_key')
}

// ---------- Streaming RPC (slice 3) ----------
//
// `sdk.sendPrompt` returns a stream of RunnerEvents while the underlying
// Tauri `invoke('rpc')` is still in flight. The Rust shell forwards
// stream frames as Tauri events on `rpc:stream:<id>`; we listen on that
// channel for the lifetime of the call.
//
// The id is generated client-side and embedded in the sidecar request so
// stream frames route to the right listener. We reach for
// `__TAURI_INTERNALS__.invoke` directly (rather than using the typed
// `call`) because we need to wire up the listener before the request
// starts streaming.

let nextStreamId = 0

export async function streamSendPrompt(
  params: MethodInput<'sdk.sendPrompt'>,
  onEvent: (ev: RunnerEvent) => void,
): Promise<MethodOutput<'sdk.sendPrompt'>> {
  if (!isTauri()) {
    throw new Error('streamSendPrompt requires the Tauri desktop shell')
  }
  const spec = Methods['sdk.sendPrompt']
  const inputParse = spec.input.safeParse(params)
  if (!inputParse.success) {
    throw new Error(`bad input for sdk.sendPrompt: ${inputParse.error.message}`)
  }
  const id = `sdk-${Date.now()}-${++nextStreamId}`
  const tauriEvent = await import('@tauri-apps/api/event')
  const tauriCore = await import('@tauri-apps/api/core')
  const channel = `rpc:stream:${id}`
  const unlisten = await tauriEvent.listen<unknown>(channel, (msg) => {
    const parsed = RunnerEventSchema.safeParse(msg.payload)
    if (parsed.success) onEvent(parsed.data)
  })
  try {
    const result = await tauriCore.invoke('rpc_stream', {
      method: 'sdk.sendPrompt',
      params: inputParse.data,
      streamId: id,
    })
    const outputParse = spec.output.safeParse(result)
    if (!outputParse.success) {
      throw new Error(`bad response for sdk.sendPrompt: ${outputParse.error.message}`)
    }
    return outputParse.data as MethodOutput<'sdk.sendPrompt'>
  } finally {
    unlisten()
  }
}
