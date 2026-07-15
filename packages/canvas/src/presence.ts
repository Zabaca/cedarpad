// Live presence (#212), client side. Transport is OURS (heartbeat POSTs + the
// existing canvas SSE stream); rendering is TLDRAW-NATIVE: remote entries become
// `instance_presence` records in the local store, which tldraw's collaborator
// machinery turns into labeled cursors, the people face-pile, and follow mode
// (`editor.startFollowingUser`). Our shape sync ignores presence records in both
// directions (its listeners filter typeName 'shape'/'binding'), so nothing here
// can leak into canvas-state or echo back to the bridge.

import { InstancePresenceRecordType, type Editor, type TLInstancePresence, type TLPageId } from 'tldraw';

import { withCanvasHeader } from './active-canvas';
import { currentUserSnapshot } from './identity';

/** One participant on the wire — the single contract both sides parse (the bridge's
 * `server/presence.ts` imports this type; `parseHeartbeat` is its runtime guard). */
export type PresenceEntry = {
  userId: string;
  name?: string;
  color: string;
  cursor: { x: number; y: number } | null;
  camera: { x: number; y: number; z: number } | null;
};

/** Map one remote entry to a tldraw presence record (pure; unit-tested). */
export function entryToPresence(e: PresenceEntry, pageId: string, now: number): TLInstancePresence {
  return InstancePresenceRecordType.create({
    id: InstancePresenceRecordType.createId(e.userId),
    userId: e.userId,
    userName: e.name ?? 'Guest',
    color: e.color,
    currentPageId: pageId as TLPageId,
    cursor: e.cursor ? { ...e.cursor, type: 'default', rotation: 0 } : null,
    camera: e.camera,
    // "Active now" — drives tldraw's cursor fade + collaborator liveness.
    lastActivityTimestamp: now,
  });
}

/** Reconcile the store's presence records against a broadcast: everyone else upserted,
 * SELF excluded (you are not your own collaborator), departed users removed. */
export function applyPresence(editor: Editor, entries: PresenceEntry[], selfId: string | undefined, now: number = Date.now()): void {
  const pageId = editor.getCurrentPageId() as string;
  const records = entries.filter((e) => e.userId !== selfId).map((e) => entryToPresence(e, pageId, now));
  const keep = new Set(records.map((r) => r.id));
  const gone = editor.store
    .allRecords()
    .filter((r) => r.typeName === 'instance_presence' && !keep.has(r.id as TLInstancePresence['id']))
    .map((r) => r.id);
  editor.store.mergeRemoteChanges(() => {
    if (gone.length) editor.store.remove(gone as never[]);
    if (records.length) editor.store.put(records);
  });
}

/** The SSE `presence` frame handler (wired in sync.ts next to the state frames). */
export function onPresenceFrame(editor: Editor, data: string): void {
  try {
    const { entries } = JSON.parse(data) as { entries: PresenceEntry[] };
    applyPresence(editor, Array.isArray(entries) ? entries : [], currentUserSnapshot()?.id);
  } catch {
    // a malformed frame is dropped; the next broadcast heals
  }
}

const BEAT_MS = 150; // change-detection cadence (a beat is sent only when something moved)
const KEEPALIVE_MS = 2_000; // …except at least this often, so staleness ≈ liveness

/** Start heartbeating this browser's cursor + camera to the bridge. Returns stop(). */
export function startPresenceHeartbeat(editor: Editor, send: (body: PresenceEntry) => void = defaultSend): () => void {
  let last = '';
  let lastSentAt = 0;
  const timer = setInterval(() => {
    const u = currentUserSnapshot();
    if (!u) return; // identity still resolving; beat once it lands
    const p = editor.inputs.currentPagePoint;
    const cam = editor.getCamera();
    const body: PresenceEntry = {
      userId: u.id,
      ...(u.name ? { name: u.name } : {}),
      color: u.color,
      cursor: { x: Math.round(p.x), y: Math.round(p.y) },
      camera: { x: Math.round(cam.x), y: Math.round(cam.y), z: Number(cam.z.toFixed(3)) },
    };
    const key = JSON.stringify(body);
    const now = Date.now();
    if (key === last && now - lastSentAt < KEEPALIVE_MS) return;
    last = key;
    lastSentAt = now;
    send(body);
  }, BEAT_MS);
  return () => clearInterval(timer);
}

function defaultSend(body: PresenceEntry): void {
  void fetch('/api/canvas/presence', {
    method: 'POST',
    headers: withCanvasHeader({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    // a missed beat is fine — the next one is 150ms away
  });
}
