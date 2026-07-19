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

/** The 🎧 toggle. Self-contained: owns the Room lifecycle, leaves on unmount. */
export function HuddleButton({ canvasId, className }: { canvasId: string; className?: string }) {
  const [state, setState] = React.useState<'idle' | 'joining' | 'live'>('idle');
  const roomRef = React.useRef<Room | null>(null);

  const leave = React.useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await leaveHuddle(room).catch(() => {});
    setState('idle');
  }, []);

  React.useEffect(() => () => void leave(), [leave]);

  const toggle = async () => {
    if (state === 'live') return leave();
    if (state !== 'idle') return;
    setState('joining');
    try {
      const room = await joinHuddle(canvasId);
      room.on(RoomEvent.Disconnected, () => {
        roomRef.current = null;
        setState('idle');
      });
      roomRef.current = room;
      setState('live');
    } catch (e) {
      console.error('[huddle]', e);
      setState('idle');
    }
  };

  return (
    <button
      type="button"
      className={`${className ?? ''} huddle-button${state === 'live' ? ' huddle-live' : ''}`}
      title={state === 'live' ? 'Leave the huddle' : 'Start or join this canvas’s voice huddle'}
      disabled={state === 'joining'}
      onClick={() => void toggle()}
    >
      {state === 'live' ? '🎧 Leave' : state === 'joining' ? '🎧 …' : '🎧 Huddle'}
    </button>
  );
}
