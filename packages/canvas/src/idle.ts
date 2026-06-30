// ponytail: idle gate so an open-but-idle tab lets the CF container reach its
// sleepAfter window instead of being pinned awake forever.
//
// Why closing (not just "stop pinging") is required: an EventSource auto-reconnects
// the instant its connection drops, so a slept container is immediately re-woken by
// the reconnect. A deliberate .close() does NOT auto-reconnect, so the container can
// sleep and STAY asleep until the tab is shown again.
//
// Trigger is tab visibility: hidden + a short grace + no agent turn in flight -> close
// both streams (chat + canvas); shown -> reopen. The turn guard keeps a container warm
// through a turn started just before the tab was backgrounded (a mid-turn sleep would
// kill the agent).
//
// ceiling: only the hidden-tab case is handled. A tab left VISIBLE but unattended still
// pins the container — close the tab, or add a DOM-activity timer here if that case
// starts mattering.

type Toggle = { open: () => void; close: () => void };

const toggles = new Set<Toggle>();
let busyCheck: () => boolean = () => false;
const GRACE_MS = 30_000; // ponytail: avoids thrash on quick tab flicks; container's 5m sleepAfter is the real delay
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let closed = false;

/** Register a stream's open/close. Returns an unregister fn (call on teardown). */
export function registerStream(t: Toggle): () => void {
  toggles.add(t);
  return () => toggles.delete(t);
}

/** Provide the "is an agent turn in flight?" predicate (set by the chat store). */
export function setBusyCheck(fn: () => boolean): void {
  busyCheck = fn;
}

function arm(): void {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = setTimeout(closeAll, GRACE_MS);
}

function closeAll(): void {
  graceTimer = null;
  if (busyCheck()) {
    arm(); // a turn is running — keep warm, re-check after another grace
    return;
  }
  if (closed) return;
  closed = true;
  for (const t of toggles) t.close();
}

function openAll(): void {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  if (!closed) return;
  closed = false;
  for (const t of toggles) t.open();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') arm();
    else openAll();
  });
}
