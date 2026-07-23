// An EventSource auto-reconnects ONLY after a network-level drop. If a (re)connect
// attempt instead receives an HTTP error or a non-`text/event-stream` body — exactly
// what the worker serves while the container cold-boots — the browser sets
// readyState CLOSED permanently and never retries; until now only a full page
// refresh re-opened the canvas stream. This wrapper owns that case: it rebuilds the
// source with capped exponential backoff, and stays out of the way of the browser's
// own CONNECTING-state retries. DOM-free (structural source type) so it's testable
// under plain bun:test.

export type RecoverableSource = {
  readyState: number;
  close(): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
};

const CLOSED = 2; // EventSource.CLOSED, restated so this module never touches DOM globals

export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createRecoveringStream<S extends RecoverableSource>(
  create: () => S,
  opts?: { baseMs?: number; maxMs?: number; timers?: Timers },
): { open: () => void; close: () => void } {
  const baseMs = opts?.baseMs ?? 1000;
  const maxMs = opts?.maxMs ?? 15000;
  const timers = opts?.timers ?? realTimers;
  let src: S | null = null;
  let retry: unknown = null;
  let attempt = 0;

  const open = (): void => {
    if (src) return;
    if (retry !== null) {
      timers.clear(retry);
      retry = null;
    }
    const s = (src = create());
    s.addEventListener('open', () => {
      if (src === s) attempt = 0;
    });
    s.addEventListener('error', () => {
      // CONNECTING means the browser is already retrying on its own; only CLOSED is
      // permanent. Ignore events from a source we've replaced or deliberately closed
      // (the idle gate must stay authoritative — its close() is final until open()).
      if (src !== s || s.readyState !== CLOSED) return;
      src = null;
      retry = timers.set(open, backoffDelay(attempt++, baseMs, maxMs));
    });
  };

  const close = (): void => {
    if (retry !== null) {
      timers.clear(retry);
      retry = null;
    }
    src?.close();
    src = null;
  };

  return { open, close };
}
