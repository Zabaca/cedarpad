import type { Env } from './index.ts';
import { containerEnv } from './container-env.ts';
import { COORDS_HEADER } from './canvas-container-lifecycle.ts';
import { selfHostedTarget, serveSelfHosted } from './self-hosted.ts';
import { type SandboxCoords, localBridgeOrigin, sseRetryResponse, wantsEventStream } from './sandbox-resolver.ts';

// The workspace runtime: where a resolved workspace's requests are served from. In order, a
// loopback bridge (E2E only), a self-hosted VM, or the workspace's `CanvasContainer` DO on
// Cloudflare's `durable_object` container policy. The pure routing decisions live in
// `sandbox-resolver.ts` and `self-hosted.ts`; the container lifecycle lives in the DO.

/** Serve a resolved workspace's request from wherever its compute lives. */
export async function serveWorkspace(request: Request, env: Env, coords: SandboxCoords): Promise<Response> {
  const url = new URL(request.url);
  // E2E ONLY (#276): no container exists locally, so the workspace IS the bridge process on a
  // loopback port. Reached only AFTER the gate and the ownership check upstream, so it bypasses
  // nothing that guards a request — it only replaces the transport into the container.
  const localBridge = localBridgeOrigin(env);
  if (localBridge) {
    const target = new URL(url.pathname + url.search, localBridge);
    return fetch(new Request(target, request));
  }
  // A workspace whose compute lives on our own hardware (worker/self-hosted.ts).
  // Placed AFTER the gate and the ownership check upstream, exactly like the E2E
  // shim above: it changes the transport into the workspace and nothing about who
  // is allowed to reach it. Returns null unless the workspace is mapped AND all
  // three credentials are present, so a partial rollout serves from the container.
  const selfHosted = selfHostedTarget(env, coords.canvasWorkspace);
  if (selfHosted) return serveSelfHosted(request, selfHosted, containerEnv(env, coords), coords);
  return serveCanvasContainer(request, env, coords);
}

/** The workspace's `CanvasContainer` DO (worker/canvas-container.ts), one per sandbox id. */
export const canvasContainerFor = (env: Env, sandboxId: string) =>
  env.CanvasContainer.get(env.CanvasContainer.idFromName(sandboxId));

// What a deploy does to a DO a request is in the middle of: the request fails, and the next
// one reaches the new code. Safe to send again only when it has no body.
const RESET_BY_DEPLOY = 'reset because its code was updated';

/**
 * The container path. Everything around the boot — single-flight, lock, readiness, idle
 * stop — lives in the DO, which is the one place there is exactly one of per container.
 * What stays here is the edge's job: telling the DO which workspace it is, and never
 * handing an EventSource a non-SSE error.
 */
export async function serveCanvasContainer(request: Request, env: Env, coords: SandboxCoords): Promise<Response> {
  const stub = canvasContainerFor(env, coords.sandboxId);
  const streamReq = wantsEventStream(request.headers.get('accept'));
  const bodiless = request.method === 'GET' || request.method === 'HEAD';
  const send = () => {
    const proxied = new Request(request);
    proxied.headers.set(COORDS_HEADER, JSON.stringify(coords));
    return stub.fetch(proxied);
  };
  try {
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      if (!bodiless || !String((e as Error)?.message ?? e).includes(RESET_BY_DEPLOY)) throw e;
      res = await send();
    }
    return streamReq && res.status >= 500 ? sseRetryResponse() : res;
  } catch (e: unknown) {
    if (streamReq) return sseRetryResponse();
    return new Response('canvas error:\n' + String((e as Error)?.stack ?? e), { status: 500 });
  }
}
