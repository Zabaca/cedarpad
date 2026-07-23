import { describe, expect, test } from 'bun:test';

import { backoffDelay, createRecoveringStream, type RecoverableSource } from './stream-recovery';

// An EventSource auto-reconnects only after a network-level drop. An HTTP error or
// non-`text/event-stream` response — exactly what the worker produces mid cold-boot —
// closes it PERMANENTLY (readyState CLOSED, no retry, no refresh short of a page
// reload). These tests pin the wrapper that owns that case.

const CONNECTING = 0;
const CLOSED = 2;

// A hand-rolled fake EventSource + a manual timer so backoff is deterministic.
function fake() {
  const listeners = new Map<string, () => void>();
  const source = {
    readyState: CONNECTING,
    closedByUs: false,
    close() {
      this.closedByUs = true;
    },
    addEventListener(type: 'open' | 'error', listener: () => void) {
      listeners.set(type, listener);
    },
    fire(type: 'open' | 'error') {
      listeners.get(type)?.();
    },
  };
  return source satisfies RecoverableSource & { fire: (t: 'open' | 'error') => void; closedByUs: boolean };
}

function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    delays: [] as number[],
    timers: {
      set(fn: () => void, ms: number) {
        const h = { fn, ms };
        pending.push(h);
        return h;
      },
      clear(h: unknown) {
        const i = pending.indexOf(h as { fn: () => void; ms: number });
        if (i >= 0) pending.splice(i, 1);
      },
    },
    fire() {
      const h = pending.shift();
      if (!h) return null;
      this.delays.push(h.ms);
      h.fn();
      return h.ms;
    },
    pendingCount: () => pending.length,
  };
}

function harness() {
  const created: Array<ReturnType<typeof fake>> = [];
  const t = manualTimers();
  const stream = createRecoveringStream(
    () => {
      const s = fake();
      created.push(s);
      return s;
    },
    { baseMs: 100, maxMs: 400, timers: t.timers },
  );
  return { created, t, stream };
}

describe('createRecoveringStream', () => {
  test('open() creates one source; a second open() while live is a no-op', () => {
    const { created, stream } = harness();
    stream.open();
    stream.open();
    expect(created.length).toBe(1);
  });

  test('an error on a CLOSED source rebuilds it after the backoff delay', () => {
    const { created, t, stream } = harness();
    stream.open();
    created[0]!.readyState = CLOSED;
    created[0]!.fire('error');
    expect(created.length).toBe(1); // not yet — waiting out the backoff
    t.fire();
    expect(created.length).toBe(2);
  });

  test('an error while CONNECTING is left to the browser (no rebuild scheduled)', () => {
    const { created, t, stream } = harness();
    stream.open();
    created[0]!.readyState = CONNECTING;
    created[0]!.fire('error');
    expect(t.pendingCount()).toBe(0);
    expect(created.length).toBe(1);
  });

  test('backoff doubles per consecutive failure, caps at maxMs, resets on open', () => {
    const { created, t, stream } = harness();
    stream.open();
    for (let i = 0; i < 4; i++) {
      const s = created[created.length - 1]!;
      s.readyState = CLOSED;
      s.fire('error');
      t.fire();
    }
    expect(t.delays).toEqual([100, 200, 400, 400]);
    // A successful connection resets the ladder.
    created[created.length - 1]!.fire('open');
    const s = created[created.length - 1]!;
    s.readyState = CLOSED;
    s.fire('error');
    expect(t.fire()).toBe(100);
  });

  test('close() closes the live source and cancels a pending rebuild', () => {
    const { created, t, stream } = harness();
    stream.open();
    created[0]!.readyState = CLOSED;
    created[0]!.fire('error');
    stream.close(); // idle gate kicks in while a retry is pending
    t.fire();
    expect(created.length).toBe(1);
    // ...and open() still works afterwards (activity returns).
    stream.open();
    expect(created.length).toBe(2);
    stream.close();
    expect(created[1]!.closedByUs).toBe(true);
  });

  test('a late error from an already-replaced source never schedules a rebuild', () => {
    const { created, t, stream } = harness();
    stream.open();
    const old = created[0]!;
    stream.close();
    old.readyState = CLOSED;
    old.fire('error');
    expect(t.pendingCount()).toBe(0);
    expect(created.length).toBe(1);
  });
});

describe('backoffDelay', () => {
  test('exponential from baseMs, capped at maxMs', () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, 1000, 15000))).toEqual([1000, 2000, 4000, 8000, 15000]);
  });
});
