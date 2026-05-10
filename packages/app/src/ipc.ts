/**
 * Renderer-side IPC. Validates outgoing input + incoming output against the
 * shared `contract.ts` schemas, so an out-of-spec request never leaves the
 * renderer and an out-of-spec response never reaches the rest of the app.
 *
 * In dev outside Tauri (browser-only `vite dev`), we fall back to a "browser
 * mode" stub that throws — the renderer guards on `window.__TAURI__` before
 * issuing IPC.
 */
import { Methods, type MethodName, type MethodInput, type MethodOutput } from './contract'

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
