// ponytail: idle gate so an open-but-idle tab lets the CF container reach its
// sleepAfter window instead of being pinned awake forever by the chat stream's 15s
// ping.
//
// Why closing (not just "stop pinging") is required: an EventSource auto-reconnects
// the instant its connection drops, so a slept container is immediately re-woken by
// the reconnect. A deliberate .close() does NOT auto-reconnect, so the container can
// sleep and STAY asleep until someone comes back.
//
// Idle is measured by USER ACTIVITY (pointer/keyboard), not tab visibility — a tab
// left open and VISIBLE but unattended (e.g. a teammate's open tab on another monitor)
// generates no activity, so it closes too. After IDLE_MS with no activity, and no agent
// turn in flight, both SSE streams (chat + canvas) close; any activity (or the tab
// being shown) reopens them. A hidden tab closes sooner.
//
// Total time to container sleep = IDLE_MS (streams close) + the worker's sleepAfter
// (the quiet window once traffic stops). Both are knobs.

type Toggle = { open: () => void; close: () => void };

const toggles = new Set<Toggle>();
let busyCheck: () => boolean = () => false;

const IDLE_MS = 120_000; // no pointer/keyboard for 2m -> close streams + stop beating
const HIDDEN_GRACE_MS = 30_000; // tab hidden -> close sooner
// Heartbeat: while our SSE streams are open, tell the bridge we're still here. The CF
// sandbox proxy never tells the bridge when a tab closes, so without this the bridge
// can't distinguish a live tab from a dead one and the container never sleeps. When we
// go idle/hidden we close the streams AND stop beating; the bridge reaps the now-silent
// streams (see server/bridge.ts STALE_MS) and the container can sleep. Must be well
// under the server's STALE_MS (bridge exits after STALE_MS with no beat).
const BEAT_MS = 30_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let beatTimer: ReturnType<typeof setInterval> | null = null;
let lastBump = 0;
let closed = false;

function beat(): void {
  void fetch('/api/alive', { method: 'POST', keepalive: true }).catch(() => {});
}
function startBeats(): void {
  if (beatTimer) return;
  beat(); // immediate, so a just-opened stream is marked alive at once
  beatTimer = setInterval(beat, BEAT_MS);
}
function stopBeats(): void {
  if (beatTimer) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}

/** Register a stream's open/close. Returns an unregister fn (call on teardown). */
export function registerStream(t: Toggle): () => void {
  toggles.add(t);
  return () => toggles.delete(t);
}

/** Provide the "is an agent turn in flight?" predicate (set by the chat store). */
export function setBusyCheck(fn: () => boolean): void {
  busyCheck = fn;
}

function scheduleClose(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(doClose, ms);
}

function doClose(): void {
  timer = null;
  if (busyCheck()) {
    scheduleClose(HIDDEN_GRACE_MS); // a turn is running — keep warm, re-check soon
    return;
  }
  if (closed) return;
  closed = true;
  for (const t of toggles) t.close();
  stopBeats(); // streams closed -> stop telling the bridge we're here -> it can reap + sleep
}

function reopen(): void {
  if (!closed) return;
  closed = false;
  for (const t of toggles) t.open();
  startBeats(); // streams reopened -> resume heartbeat so the bridge keeps them
}

function activity(): void {
  if (closed) reopen(); // someone's back — reopen immediately
  const now = Date.now();
  if (now - lastBump < 1000) return; // throttle: pointermove fires a lot
  lastBump = now;
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') scheduleClose(IDLE_MS);
}

if (typeof document !== 'undefined') {
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
    document.addEventListener(ev, activity, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scheduleClose(HIDDEN_GRACE_MS);
    else activity();
  });
  scheduleClose(IDLE_MS); // arm on load so a never-touched tab still closes
  startBeats(); // streams open on load -> beat until we go idle/hidden
}
