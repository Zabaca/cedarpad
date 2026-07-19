// Huddle client (ADR-0017): join the canvas's voice room. The edge mints the token
// (POST /api/canvases/:id/huddle/join — member session or guestHuddle link, both
// server-checked) and ensures the agent worker; this module owns the browser side:
// connect, publish the mic, and play every remote participant's audio.
import * as React from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

export async function joinHuddle(canvasId: string): Promise<Room> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/huddle/join`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`huddle join failed: ${res.status}`);
  const { url, token } = (await res.json()) as { url: string; token: string };
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.dataset.huddle = canvasId;
    document.body.appendChild(el);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    for (const el of track.detach()) el.remove();
  });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  return room;
}

export async function leaveHuddle(room: Room): Promise<void> {
  await room.disconnect();
  for (const el of document.querySelectorAll('audio[data-huddle]')) el.remove();
}

const AGENT = 'cedar';

/** While live: who's in the room, cedar's state (listening/thinking/speaking — the
 * agent publishes it as the lk.agent.state participant attribute), and live captions
 * from the lk.transcription text stream. This is how you can TELL the agent heard you. */
function HuddleStatus({ room }: { room: Room }) {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const [caption, setCaption] = React.useState<{ who: string; text: string } | null>(null);

  React.useEffect(() => {
    const rerender = () => force();
    room.on(RoomEvent.ParticipantConnected, rerender);
    room.on(RoomEvent.ParticipantDisconnected, rerender);
    room.on(RoomEvent.ParticipantAttributesChanged, rerender);
    room.on(RoomEvent.ActiveSpeakersChanged, rerender);
    try {
      room.registerTextStreamHandler('lk.transcription', async (reader) => {
        // The agent publishes ALL transcriptions. lk.transcribed_track_id names whose
        // audio was transcribed: one of our tracks ⇒ "you" (proof cedar heard you);
        // absent/foreign ⇒ cedar's own speech.
        const trackId = reader.info.attributes?.['lk.transcribed_track_id'];
        const mine = !!trackId && room.localParticipant.audioTrackPublications.has(trackId);
        const who = mine ? 'you' : AGENT;
        const text = await reader.readAll();
        if (text.trim()) setCaption({ who, text });
      });
    } catch {
      /* handler already registered for this topic */
    }
    return () => {
      room.off(RoomEvent.ParticipantConnected, rerender);
      room.off(RoomEvent.ParticipantDisconnected, rerender);
      room.off(RoomEvent.ParticipantAttributesChanged, rerender);
      room.off(RoomEvent.ActiveSpeakersChanged, rerender);
      room.unregisterTextStreamHandler?.('lk.transcription');
    };
  }, [room]);

  const cedar = room.remoteParticipants.get(AGENT);
  const cedarState = cedar?.attributes?.['lk.agent.state'] ?? (cedar ? 'connected' : 'joining…');
  const speaking = room.activeSpeakers.map((p) => p.identity);
  const others = [...room.remoteParticipants.values()].filter((p) => p.identity !== AGENT);

  return (
    <div className="huddle-status">
      <div className="huddle-row">
        <span className={`huddle-dot ${cedar ? `st-${cedarState}` : 'st-off'}`} />
        <b>cedar</b>
        <span className="huddle-state">{cedarState}</span>
        {speaking.includes(AGENT) && <span className="huddle-speaking">● speaking</span>}
      </div>
      <div className="huddle-row huddle-peers">
        you{speaking.includes(room.localParticipant.identity) ? ' ●' : ''}
        {others.map((p) => ` · ${p.identity}${speaking.includes(p.identity) ? ' ●' : ''}`)}
      </div>
      {caption && (
        <div className="huddle-caption">
          <b>{caption.who}:</b> {caption.text}
        </div>
      )}
    </div>
  );
}

/** The 🎧 toggle. Self-contained: owns the Room lifecycle, leaves on unmount. */
// --- connection manager (module-level, OUTSIDE React) ---------------------------------
// The call must survive UI changes: collapsing the panel unmounts its components, and a
// connection owned by a component dies with it. The manager owns the Room; buttons and
// status cards are disposable views over it.
type HuddleState = { room: Room | null; phase: 'idle' | 'joining' | 'live' };
let hs: HuddleState = { room: null, phase: 'idle' };
const hsListeners = new Set<() => void>();
function setHs(next: HuddleState) {
  hs = next;
  for (const l of hsListeners) l();
}

export async function huddleJoin(canvasId: string): Promise<void> {
  if (hs.phase !== 'idle') return;
  setHs({ room: null, phase: 'joining' });
  try {
    const room = await joinHuddle(canvasId);
    room.on(RoomEvent.Disconnected, () => setHs({ room: null, phase: 'idle' }));
    setHs({ room, phase: 'live' });
  } catch (e) {
    console.error('[huddle]', e);
    setHs({ room: null, phase: 'idle' });
  }
}

export async function huddleLeave(): Promise<void> {
  const room = hs.room;
  setHs({ room: null, phase: 'idle' });
  if (room) await leaveHuddle(room).catch(() => {});
}

export function useHuddle(): HuddleState {
  return React.useSyncExternalStore(
    (cb) => {
      hsListeners.add(cb);
      return () => hsListeners.delete(cb);
    },
    () => hs,
  );
}

export function HuddleButton({ canvasId, className }: { canvasId: string; className?: string }) {
  const { phase } = useHuddle();
  return (
    <button
      type="button"
      className={`${className ?? ''} huddle-button${phase === 'live' ? ' huddle-live' : ''}`}
      title={phase === 'live' ? 'Leave the huddle' : 'Start or join this canvas’s voice huddle'}
      disabled={phase === 'joining'}
      onClick={() => void (phase === 'live' ? huddleLeave() : huddleJoin(canvasId))}
    >
      {phase === 'live' ? '🎧 Leave' : phase === 'joining' ? '🎧 …' : '🎧 Huddle'}
    </button>
  );
}

/** Button + (while live) the status overlay — a pure view; safe to unmount anytime. */
export function HuddleControl({ canvasId, className }: { canvasId: string; className?: string }) {
  const { room } = useHuddle();
  return (
    <>
      <HuddleButton canvasId={canvasId} className={className} />
      {room && <HuddleStatus room={room} />}
    </>
  );
}

/** Floating huddle card for when the side panel is hidden mid-call: renders only while
 * live (or joining), so an idle collapsed panel adds no chrome. */
export function HuddleFloat({ canvasId }: { canvasId: string }) {
  const { phase } = useHuddle();
  if (phase === 'idle') return null;
  return (
    <div className="huddle-float">
      <HuddleControl canvasId={canvasId} className="side-panel-add" />
    </div>
  );
}
