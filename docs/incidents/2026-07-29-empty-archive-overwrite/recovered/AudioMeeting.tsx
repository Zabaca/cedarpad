// A P2P audio meeting room, placeable on the canvas. Press "Join" to open your mic and
// mesh-connect (WebRTC, audio-only) to everyone else already in the room; press "Leave" to
// hang up. No media server — audio flows directly browser-to-browser (STUN-assisted NAT
// traversal only, no TURN relay configured), so it's best for small groups (a handful of
// people) on typical home/office networks; very restrictive corporate NATs may fail to connect.
//
// Signaling piggybacks on this shape's own synced `data` (the same setData channel Kanban/
// QABoard use for realtime multiplayer state) instead of a separate server: every top-level
// data key is owned by exactly one writer, so concurrent joins/leaves/negotiations never clobber
// each other —
//   meet_p_<id>            presence row, written only by participant <id> (null when they leave)
//   meet_sig_<from>__<to>   one WebRTC envelope {type, sdp, candidates[]}, written only by <from>
// A newly-joining participant always initiates the offer to everyone already present; existing
// participants just answer. (Two people joining in the exact same instant can race and fail to
// connect to each other — rare in practice; a rejoin fixes it.)
import { useEffect, useRef, useState } from 'react';

type Presence = { id: string; name: string; joinedAt: number };
type Envelope = { type: 'offer' | 'answer'; sdp: string; candidates: RTCIceCandidateInit[] };
type ConnState = 'connecting' | 'connected' | 'failed';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `u_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const AVATAR_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
function colorFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function AudioSink({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}

type CurrentUser = { id?: string; name?: string; kind?: string } | undefined;

export default function AudioMeeting({
  setData,
  currentUser,
  setDisplayName,
  title = 'Audio meeting',
  ...raw
}: {
  setData?: (patch: Record<string, unknown>) => void;
  currentUser?: CurrentUser;
  setDisplayName?: (name: string) => void;
  title?: string;
  [key: string]: unknown;
}) {
  const myIdRef = useRef<string>((currentUser?.id as string) || uid());
  const myId = (currentUser?.id as string) || myIdRef.current;

  const [nameDraft, setNameDraft] = useState('');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'joined'>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<Record<string, ConnState>>({});
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Record<string, { pc: RTCPeerConnection }>>({});
  const candidateBufRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const envelopeMetaRef = useRef<Record<string, { type: 'offer' | 'answer'; sdp: string }>>({});
  const appliedRef = useRef<Record<string, number>>({});

  const roster: Presence[] = Object.entries(raw)
    .filter(([k, v]) => k.startsWith('meet_p_') && v && typeof v === 'object')
    .map(([, v]) => v as Presence)
    .sort((a, b) => a.joinedAt - b.joinedAt);

  const displayName = (currentUser?.name as string) || nameDraft.trim() || 'Anonymous';

  const flush = (peerId: string) => {
    const meta = envelopeMetaRef.current[peerId];
    if (!meta) return;
    setData?.({ [`meet_sig_${myId}__${peerId}`]: { type: meta.type, sdp: meta.sdp, candidates: candidateBufRef.current[peerId] ?? [] } });
  };

  const connectTo = async (peerId: string, isInitiator: boolean, incomingOffer?: Envelope) => {
    if (peersRef.current[peerId]) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peersRef.current[peerId] = { pc };
    candidateBufRef.current[peerId] = [];
    appliedRef.current[peerId] = 0;
    setConnStatus((s) => ({ ...s, [peerId]: 'connecting' }));

    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current as MediaStream));

    pc.ontrack = (e) => setRemoteStreams((s) => ({ ...s, [peerId]: e.streams[0] as MediaStream }));
    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      setConnStatus((s) => ({ ...s, [peerId]: cs === 'connected' ? 'connected' : cs === 'failed' ? 'failed' : 'connecting' }));
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      (candidateBufRef.current[peerId] ??= []).push(e.candidate.toJSON());
      flush(peerId);
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      envelopeMetaRef.current[peerId] = { type: 'offer', sdp: offer.sdp ?? '' };
      flush(peerId);
    } else if (incomingOffer) {
      await pc.setRemoteDescription({ type: 'offer', sdp: incomingOffer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      envelopeMetaRef.current[peerId] = { type: 'answer', sdp: answer.sdp ?? '' };
      flush(peerId);
      incomingOffer.candidates.forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
      appliedRef.current[peerId] = incomingOffer.candidates.length;
    }
  };

  const join = async () => {
    setError(null);
    setStatus('connecting');
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access denied or unavailable.');
      setStatus('idle');
      return;
    }
    const others = roster.filter((p) => p.id !== myId);
    setData?.({ [`meet_p_${myId}`]: { id: myId, name: displayName, joinedAt: Date.now() } });
    setStatus('joined');
    others.forEach((p) => connectTo(p.id, true));
  };

  const leave = () => {
    Object.values(peersRef.current).forEach((p) => p.pc.close());
    peersRef.current = {};
    candidateBufRef.current = {};
    envelopeMetaRef.current = {};
    appliedRef.current = {};
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setRemoteStreams({});
    setConnStatus({});
    const patch: Record<string, unknown> = { [`meet_p_${myId}`]: null };
    roster.forEach((p) => {
      if (p.id !== myId) patch[`meet_sig_${myId}__${p.id}`] = null;
    });
    setData?.(patch);
    setStatus('idle');
    setMuted(false);
  };

  const toggleMute = () => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };

  // Reconcile inbound offers/answers/candidates, and drop connections to peers who left.
  // Keyed off a plain-string snapshot of the relevant data so it reruns whenever any
  // meet_* field changes, without needing every dynamic key named in a dep array.
  const dataSnapshot = JSON.stringify(raw);
  useEffect(() => {
    if (status !== 'joined') return;
    Object.entries(raw).forEach(([key, value]) => {
      const m = /^meet_sig_(.+?)__(.+)$/.exec(key);
      if (!m) return;
      const fromId = m[1] as string;
      const toId = m[2] as string;
      if (toId !== myId || fromId === myId) return;
      const envelope = value as Envelope | null;
      if (!envelope) return;
      const existing = peersRef.current[fromId];
      if (!existing) {
        if (envelope.type === 'offer') connectTo(fromId, false, envelope);
        return;
      }
      if (envelope.type === 'answer' && existing.pc.signalingState === 'have-local-offer') {
        existing.pc.setRemoteDescription({ type: 'answer', sdp: envelope.sdp }).catch(() => {});
      }
      const applied = appliedRef.current[fromId] ?? 0;
      envelope.candidates.slice(applied).forEach((c) => existing.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
      appliedRef.current[fromId] = envelope.candidates.length;
    });

    const currentIds = new Set(roster.map((p) => p.id));
    Object.keys(peersRef.current).forEach((id) => {
      if (currentIds.has(id)) return;
      peersRef.current[id]?.pc.close();
      delete peersRef.current[id];
      setRemoteStreams((s) => {
        const n = { ...s };
        delete n[id];
        return n;
      });
      setConnStatus((s) => {
        const n = { ...s };
        delete n[id];
        return n;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSnapshot, status]);

  const dotColor = (id: string): string => {
    if (id === myId) return muted ? '#f59e0b' : '#10b981';
    const cs = connStatus[id];
    return cs === 'connected' ? '#10b981' : cs === 'failed' ? '#ef4444' : '#9ca3af';
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        font: '13px ui-sans-serif, system-ui',
        color: '#0f172a',
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {Object.entries(remoteStreams).map(([id, s]) => (
        <AudioSink key={id} stream={s} />
      ))}

      <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>🎙 {title}</span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{roster.length} in room</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {status === 'joined' && (
            <button
              type="button"
              onClick={toggleMute}
              style={{ border: '1px solid #e2e8f0', background: muted ? '#fef3c7' : '#fff', color: muted ? '#92400e' : '#334155', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}
            >
              {muted ? '🔇 Unmute' : '🎤 Mute'}
            </button>
          )}
          <button
            type="button"
            onClick={status === 'joined' ? leave : join}
            disabled={status === 'connecting'}
            style={{
              border: 'none',
              borderRadius: 6,
              padding: '5px 12px',
              cursor: status === 'connecting' ? 'default' : 'pointer',
              fontWeight: 700,
              fontSize: 12,
              color: '#fff',
              background: status === 'joined' ? '#dc2626' : status === 'connecting' ? '#94a3b8' : '#16a34a',
            }}
          >
            {status === 'joined' ? 'Leave' : status === 'connecting' ? 'Joining…' : 'Join'}
          </button>
        </div>
      </div>

      {status !== 'joined' && !currentUser?.name && (
        <div style={{ padding: '8px 12px 0' }}>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Your name (optional)"
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 9px', font: 'inherit' }}
          />
        </div>
      )}

      {error && <div style={{ margin: '8px 12px 0', color: '#dc2626', fontSize: 12 }}>{error}</div>}

      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {roster.length === 0 && <div style={{ color: '#94a3b8', textAlign: 'center', padding: '20px 8px' }}>Nobody's here yet — be the first to join.</div>}
        {roster.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, padding: '7px 9px' }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: dotColor(p.id), flexShrink: 0 }} />
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: colorFor(p.id),
                color: '#fff',
                fontSize: 10,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {(p.name || '?').slice(0, 1).toUpperCase()}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
              {p.id === myId ? ' (you)' : ''}
            </span>
            {p.id !== myId && <span style={{ fontSize: 11, color: '#94a3b8' }}>{connStatus[p.id] ?? '…'}</span>}
          </div>
        ))}
      </div>

      <div style={{ padding: '6px 12px', borderTop: '1px solid #e2e8f0', fontSize: 10.5, color: '#94a3b8' }}>
        Direct peer-to-peer audio (STUN only, no relay) — best for small groups on typical networks.
      </div>
    </div>
  );
}
