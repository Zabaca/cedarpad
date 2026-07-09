// Collapse concurrent callers for the same key onto ONE in-flight promise (#138).
//
// The cold-boot path (serveWorkspace) had a stampede: a single page load fires ~40 requests at a
// sleeping container, and each one independently ran ensureStack's kill+startProcess. They
// canceled each other's freshly-started vite process, so the container never came up ("not
// listening in the TCP address …:4510"). Single-flighting the boot means concurrent cold requests
// AWAIT one boot instead of racing it.
//
// The map is module-scoped at the call site, so the collapse is per-isolate. Cloudflare may run a
// few isolates for one hostname, but this turns ~40 concurrent boots into ~1 per isolate — the
// mutual cancellation is gone. As long as any awaiter's request is still alive, the shared boot
// runs to completion, so an early-returning request can no longer cancel it.
export function singleFlight<T>(inflight: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  // Clear on settle (success OR failure) so the NEXT cold cycle — after the container sleeps again
  // — starts a fresh boot rather than reusing a stale resolved/rejected promise. The identity guard
  // makes sure a settled boot only clears its OWN entry, never a newer one for the same key.
  const started: Promise<T> = fn().finally(() => {
    if (inflight.get(key) === started) inflight.delete(key);
  });
  inflight.set(key, started);
  return started;
}
