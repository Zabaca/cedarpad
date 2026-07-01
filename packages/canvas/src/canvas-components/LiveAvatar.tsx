import { useEffect, useRef, useState, useCallback } from 'react';
import { LiveAvatarSession, SessionEvent, SessionState, AgentEventsEnum, SessionInteractivityMode } from '@heygen/liveavatar-web-sdk';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';
// Mic (voice chat) lifecycle: off → starting (perm prompt) → live (open mic) ⇄ muted.
type Mic = 'off' | 'starting' | 'live' | 'muted';

interface Transcript {
  role: 'user' | 'avatar';
  text: string;
}

export default function LiveAvatar() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript[]>([]);
  const [input, setInput] = useState('');
  const [mic, setMic] = useState<Mic>('off');

  // --- credit-free mic self-test: getUserMedia + live level meter, NO avatar session.
  // Proves browser permission + audio capture (the same getUserMedia the SDK's
  // voiceChat.start() uses), so the only thing left untested before connecting is
  // HeyGen's speech→LLM→avatar pipeline, which is what actually costs credits.
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [testErr, setTestErr] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const start = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    setMic('off');
    try {
      const res = await fetch('/api/live-avatar-token');
      if (!res.ok) throw new Error('Failed to fetch token');
      const { token } = await res.json();

      // voiceChat: true enables the mic subsystem (session.voiceChat). We start it
      // lazily on the mic button so the browser permission prompt is user-triggered.
      const session = new LiveAvatarSession(token, { voiceChat: true });
      sessionRef.current = session;

      session.on(SessionEvent.SESSION_STATE_CHANGED, (state) => {
        if (state === SessionState.CONNECTED) setStatus('connected');
        if (state === SessionState.DISCONNECTED) setStatus('idle');
        if (state === SessionState.DISCONNECTING) setStatus('disconnecting');
      });

      session.on(SessionEvent.SESSION_STREAM_READY, () => {
        if (videoRef.current) session.attach(videoRef.current);
      });

      session.on(AgentEventsEnum.USER_TRANSCRIPTION as any, (e: any) => {
        setTranscript(t => [...t, { role: 'user', text: e?.text ?? '' }]);
      });

      session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION as any, (e: any) => {
        setTranscript(t => [...t, { role: 'avatar', text: e?.text ?? '' }]);
      });

      await session.start();
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
      setStatus('error');
    }
  }, []);

  const stop = useCallback(async () => {
    const s = sessionRef.current;
    // Return the UI to idle immediately so Stop can never get wedged on
    // "disconnecting" if the SDK's stop() is slow or never settles; tear the
    // session down best-effort in the background.
    sessionRef.current = null;
    setStatus('idle');
    setMic('off');
    setTranscript([]);
    try {
      await s?.stop();
    } catch {
      /* best-effort; UI is already reset */
    }
  }, []);

  const send = useCallback(() => {
    if (!sessionRef.current || !input.trim()) return;
    const text = input.trim();
    // Conversational (FULL mode): .message() sends to the agent, which replies and
    // speaks. (Same agent the mic talks to — so typing and talking share one brain.)
    // No local echo: the SDK emits a USER_TRANSCRIPTION for the message, which the
    // transcript listener already renders (a local echo would double the "You" line).
    sessionRef.current.message(text);
    setInput('');
  }, [input]);

  // Start the mic (open-mic conversational voice) on first press, then toggle mute.
  // Wrapped so a denied/failed mic never crashes the card — it just resets to off.
  const toggleMic = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      if (mic === 'off') {
        setMic('starting');
        await s.voiceChat.start({ mode: SessionInteractivityMode.CONVERSATIONAL, defaultMuted: false });
        setMic('live');
      } else if (mic === 'live') {
        await s.voiceChat.mute();
        setMic('muted');
      } else if (mic === 'muted') {
        await s.voiceChat.unmute();
        setMic('live');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Mic error');
      setMic('off');
    }
  }, [mic]);

  const stopMicTest = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setTesting(false);
    setLevel(0);
  }, []);

  const startMicTest = useCallback(async () => {
    setTestErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      setTesting(true);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3)); // RMS, scaled for visibility
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e: any) {
      setTestErr(e?.message ?? 'Mic access failed');
      setTesting(false);
    }
  }, []);

  useEffect(() => () => { sessionRef.current?.stop(); stopMicTest(); }, [stopMicTest]);

  const statusColor: Record<Status, string> = {
    idle: '#6b7280',
    connecting: '#f59e0b',
    connected: '#10b981',
    disconnecting: '#f59e0b',
    error: '#ef4444',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f0f', color: '#f3f4f6', fontFamily: 'system-ui, sans-serif', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#1a1a1a', borderBottom: '1px solid #2a2a2a' }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[status] }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>LiveAvatar</span>
        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 4 }}>{status}</span>
        <div style={{ flex: 1 }} />
        {status === 'idle' || status === 'error' ? (
          <>
            <button onClick={testing ? stopMicTest : startMicTest} title="Test your microphone without connecting (no credits used)" style={{ padding: '4px 12px', background: testing ? '#dc2626' : '#374151', border: 'none', borderRadius: 5, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>{testing ? 'Stop test' : '🎤 Test mic'}</button>
            <button onClick={start} style={{ padding: '4px 12px', background: '#10b981', border: 'none', borderRadius: 5, color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Start</button>
          </>
        ) : (
          <button onClick={stop} disabled={status === 'disconnecting'} style={{ padding: '4px 12px', background: '#374151', border: 'none', borderRadius: 5, color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}>Stop</button>
        )}
      </div>

      {/* Video */}
      <div style={{ position: 'relative', background: '#000', aspectRatio: '16/9' }}>
        <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'connected' ? 'block' : 'none' }} />
        {status !== 'connected' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 }}>
            {testing ? (
              <>
                <span style={{ fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>🎤 Speak — the bar should move</span>
                <div style={{ width: '70%', height: 14, background: '#1f2937', borderRadius: 7, overflow: 'hidden', border: '1px solid #374151' }}>
                  <div style={{ width: `${Math.round(level * 100)}%`, height: '100%', background: level > 0.04 ? '#10b981' : '#4b5563', transition: 'width 60ms linear' }} />
                </div>
                <span style={{ fontSize: 10, color: '#6b7280', textAlign: 'center' }}>Browser mic only · no avatar session · no credits used</span>
                {testErr && <span style={{ fontSize: 11, color: '#ef4444', textAlign: 'center' }}>{testErr}</span>}
              </>
            ) : (
              <>
                <div style={{ fontSize: 36 }}>🎭</div>
                {status === 'connecting' && <span style={{ fontSize: 12, color: '#f59e0b' }}>Connecting…</span>}
                {status === 'idle' && <span style={{ fontSize: 12, color: '#6b7280' }}>Press Start (or Test mic first)</span>}
                {error && <span style={{ fontSize: 11, color: '#ef4444', maxWidth: 200, textAlign: 'center' }}>{error}</span>}
              </>
            )}
          </div>
        )}
      </div>

      {/* Transcript */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 60 }}>
        {transcript.length === 0 && (
          <div style={{ color: '#4b5563', fontSize: 11, textAlign: 'center', marginTop: 8 }}>Transcript will appear here</div>
        )}
        {transcript.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 10, color: t.role === 'avatar' ? '#10b981' : '#60a5fa', minWidth: 42, paddingTop: 1, fontWeight: 600 }}>{t.role === 'avatar' ? 'Avatar' : 'You'}</span>
            <span style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.4 }}>{t.text}</span>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid #2a2a2a', alignItems: 'center' }}>
        {(() => {
          const off = status !== 'connected';
          const label = mic === 'live' ? '🔴 Listening' : mic === 'muted' ? '🔇 Muted' : mic === 'starting' ? '…' : '🎤 Talk';
          const bg = off ? '#1f2937' : mic === 'live' ? '#dc2626' : mic === 'muted' ? '#374151' : '#7c3aed';
          return (
            <button
              type="button"
              onClick={toggleMic}
              disabled={off || mic === 'starting'}
              title={mic === 'off' ? 'Talk to the avatar (uses your mic)' : mic === 'live' ? 'Mute mic' : 'Unmute mic'}
              style={{ padding: '6px 10px', background: bg, border: 'none', borderRadius: 5, color: off ? '#4b5563' : '#fff', fontSize: 12, fontWeight: 600, cursor: off ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
            >
              {label}
            </button>
          );
        })()}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder={status === 'connected' ? 'Type a message…' : 'Connect first'}
          disabled={status !== 'connected'}
          style={{ flex: 1, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 5, padding: '6px 10px', color: '#f3f4f6', fontSize: 12, outline: 'none' }}
        />
        <button onClick={send} disabled={status !== 'connected' || !input.trim()} style={{ padding: '6px 12px', background: status === 'connected' ? '#2563eb' : '#1f2937', border: 'none', borderRadius: 5, color: status === 'connected' ? '#fff' : '#4b5563', fontSize: 12, cursor: status === 'connected' ? 'pointer' : 'default' }}>Send</button>
      </div>
    </div>
  );
}
