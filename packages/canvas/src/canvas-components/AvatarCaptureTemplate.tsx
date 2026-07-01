// Performance Capture — fixed camera, subject animated. Captures the dynamic +
// voice + consent half of the fingerprint (feeds HeyGen/OmniHuman + ElevenLabs).
// Clips persist to IndexedDB (survive refresh) AND upload to disk via the shared
// useCaptureRig hook, so the pipeline can read them. For geometry/3DGS, see
// GeometryCapture.

import { useMemo } from 'react';
import { useCaptureRig, fmt, type Shot } from './captureRig';

const ACCENT = '#a78bfa';

function shots(fullName: string): Shot[] {
  return [
    { id: 'consent', name: 'Consent', icon: '✋', target: 20, kind: 'script',
      instruction: 'Read the statement aloud, word for word, looking straight at the camera.',
      script: `I, ${fullName}, am currently speaking and consent to the creation of an AI clone of my likeness using the audio and video samples I provide. I understand this AI clone can be used to create videos that look and sound like me.` },
    { id: 'talk', name: 'Talking · neutral', icon: '💬', target: 60, kind: 'talk',
      instruction: 'Speak naturally to camera — introduce yourself, describe your day. Friendly, neutral tone. Drives your speaking identity.' },
    { id: 'silent', name: 'Silent · listening', icon: '🤫', target: 60, kind: 'silent',
      instruction: 'Stay quiet and look at the camera. Blink and react naturally, as if listening. Drives idle / listening behaviour.' },
    { id: 'expr', name: 'Expressions', icon: '😀', target: 40, kind: 'expr',
      instruction: 'Cycle slowly: neutral → smile → serious → surprised → laugh. Hold each ~6s. Captures emotional range.' },
    { id: 'angles', name: 'Head angles', icon: '🔄', target: 30, kind: 'angles',
      instruction: 'Eyes on camera while slowly turning your head: left, right, up, down, back to centre. Smooth and steady.' },
    { id: 'voice', name: 'Voice sample', icon: '🎙️', target: 45, kind: 'script',
      instruction: 'Read the passage clearly at a natural pace. Clean voice-clone source (ElevenLabs).',
      script: 'The quiet harbor town woke slowly as orange light spilled over the rooftops. Five judges quickly examined the bright vintage car before the busy market opened. I would gladly pay for a thorough, honest job — measure twice, cut once, and never rush the finish.' },
  ];
}

const iconBtn: any = { width: 24, height: 24, padding: 0, background: '#26262e', border: 'none', borderRadius: 5, color: '#d1d5db', fontSize: 11, cursor: 'pointer', flexShrink: 0 };

export default function AvatarCaptureTemplate({
  fullName = 'James [Last Name]', session = 'james-performance',
}: { fullName?: string; session?: string }) {
  const SHOTS = useMemo(() => shots(fullName), [fullName]);
  const r = useCaptureRig(session, SHOTS);
  const { shot } = r;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f12', color: '#f3f4f6', fontFamily: 'system-ui, sans-serif', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#17171c', borderBottom: '1px solid #26262e' }}>
        <span style={{ fontSize: 14 }}>🎬</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Performance Capture</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#8b8b96' }}>{r.captured}/{r.shots.length} · {r.savedCount} saved</span>
        <div style={{ width: 64, height: 5, background: '#26262e', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${(r.captured / r.shots.length) * 100}%`, height: '100%', background: ACCENT, transition: 'width .3s' }} />
        </div>
      </div>

      {/* Preview */}
      <div style={{ position: 'relative', background: '#000', aspectRatio: '4/3' }}>
        <canvas ref={r.canvasRef} style={{ width: '100%', height: '100%', objectFit: 'cover', display: r.ready && !r.reviewId ? 'block' : 'none', transform: 'scaleX(-1)' }} />
        <video ref={r.videoRef} playsInline controls style={{ width: '100%', height: '100%', objectFit: 'cover', display: r.reviewId ? 'block' : 'none' }} />
        <video ref={r.rawVideoRef} playsInline muted style={{ display: 'none' }} />

        {r.ready && !r.reviewId && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            <ellipse cx="50" cy="42" rx="20" ry="27" fill="none" stroke={r.recId ? '#ef4444' : ACCENT} strokeWidth="0.5" strokeDasharray="2 1.5" opacity="0.8" />
            <line x1="33.3" y1="0" x2="33.3" y2="100" stroke="#fff" strokeWidth="0.2" opacity="0.18" />
            <line x1="66.6" y1="0" x2="66.6" y2="100" stroke="#fff" strokeWidth="0.2" opacity="0.18" />
          </svg>
        )}

        {r.recId && (
          <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,.55)', padding: '4px 9px', borderRadius: 20 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#ef4444' }} />
            <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.elapsed)}</span>
            <span style={{ fontSize: 11, color: r.reachedTarget ? '#34d399' : '#d1d5db' }}>/ {fmt(shot.target)} {r.reachedTarget ? '✓' : ''}</span>
          </div>
        )}
        {r.reviewId && (
          <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,.55)', padding: '4px 9px', borderRadius: 20, fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>▶ {r.shots.find(s => s.id === r.reviewId)?.name}</div>
        )}

        {r.ready && !r.reviewId && shot && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 12px', background: 'linear-gradient(transparent, rgba(0,0,0,.82))' }}>
            {shot.script
              ? <div style={{ fontSize: 14, lineHeight: 1.5, fontWeight: 600, color: '#fff', maxHeight: 96, overflowY: 'auto', textShadow: '0 1px 3px rgba(0,0,0,.8)' }}>“{shot.script}”</div>
              : <div style={{ fontSize: 12, lineHeight: 1.45, color: '#e5e7eb' }}>{shot.instruction}</div>}
          </div>
        )}

        {!r.ready && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }}>
            <div style={{ fontSize: 40 }}>📷</div>
            <button onClick={r.enableCam} style={{ padding: '8px 18px', background: ACCENT, border: 'none', borderRadius: 7, color: '#0f0f12', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Enable camera & mic</button>
            <span style={{ fontSize: 10, color: '#6b7280', textAlign: 'center', maxWidth: 250 }}>Saved on this device (survives refresh) and synced to disk for the pipeline.</span>
            {r.camErr && <span style={{ fontSize: 11, color: '#ef4444', textAlign: 'center' }}>{r.camErr}</span>}
          </div>
        )}
      </div>

      {/* Zoom (digital — baked into the recording) */}
      {r.ready && !r.reviewId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: '#131318', borderBottom: '1px solid #26262e' }}>
          <span style={{ fontSize: 11, color: '#8b8b96' }}>🔍 Zoom</span>
          <input type="range" min="1" max="4" step="0.1" value={r.zoom} onChange={e => r.setZoom(parseFloat(e.target.value))} style={{ flex: 1, accentColor: ACCENT }} />
          <span style={{ fontSize: 11, color: '#d1d5db', width: 30, textAlign: 'right' }}>{r.zoom.toFixed(1)}×</span>
        </div>
      )}

      {/* Record controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #26262e', background: '#131318' }}>
        {!r.recId ? (
          <button onClick={r.startRec} disabled={!r.ready} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', background: r.ready ? '#ef4444' : '#2a2a32', border: 'none', borderRadius: 7, color: r.ready ? '#fff' : '#5b5b66', fontSize: 13, fontWeight: 700, cursor: r.ready ? 'pointer' : 'default' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.ready ? '#fff' : '#5b5b66' }} />
            Record {shot ? `“${shot.name}”` : ''}
          </button>
        ) : (
          <button onClick={r.stopRec} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', background: '#fff', border: 'none', borderRadius: 7, color: '#0f0f12', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444' }} />
            Stop {r.reachedTarget ? '· enough' : '· keep going'}
          </button>
        )}
        <div style={{ flex: 1, height: 6, background: '#26262e', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${r.pct * 100}%`, height: '100%', background: r.reachedTarget ? '#34d399' : ACCENT, transition: 'width .15s linear' }} />
        </div>
        {r.reviewId && <button onClick={r.backToCam} style={{ padding: '6px 10px', background: '#2a2a32', border: 'none', borderRadius: 6, color: '#d1d5db', fontSize: 11, cursor: 'pointer' }}>↩ Live</button>}
      </div>

      {/* Shot list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {r.shots.map((s, i) => {
          const clip = r.clips[s.id];
          const isActive = i === r.active, isRec = r.recId === s.id, isSync = r.syncing === s.id;
          const statusText = isRec ? 'recording…' : isSync ? 'saving to disk…' : clip ? (clip.saved ? `saved · ${fmt(clip.duration)}` : `on device · ${fmt(clip.duration)}`) : 'not captured';
          const statusColor = isRec ? '#ef4444' : isSync ? '#fbbf24' : clip ? (clip.saved ? '#34d399' : '#fbbf24') : '#6b7280';
          return (
            <div key={s.id} onClick={() => !r.recId && r.setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', margin: '3px 0', borderRadius: 8, cursor: r.recId ? 'default' : 'pointer', background: isActive ? '#1d1d24' : 'transparent', border: `1px solid ${isActive ? ACCENT + '66' : 'transparent'}` }}>
              <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>{s.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: isActive ? '#fff' : '#d1d5db' }}>{s.name}</span>
                  <span style={{ fontSize: 10, color: '#6b7280' }}>~{s.target}s</span>
                </div>
                <div style={{ fontSize: 10.5, color: statusColor, marginTop: 1 }}>{statusText}</div>
              </div>
              {clip && !r.recId && (
                <>
                  <button onClick={e => { e.stopPropagation(); r.review(s.id); }} title="Review" style={iconBtn}>▶</button>
                  <button onClick={e => { e.stopPropagation(); r.setActive(i); r.startRec(); }} title="Re-record" style={iconBtn}>↻</button>
                  {!clip.saved && <button onClick={e => { e.stopPropagation(); r.reSync(s.id); }} title="Retry save to disk" style={{ ...iconBtn, color: '#fbbf24' }}>⤴</button>}
                  <button onClick={e => { e.stopPropagation(); r.download(s.id); }} title="Download" style={iconBtn}>⤓</button>
                </>
              )}
              {!clip && <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${isActive ? ACCENT : '#3a3a44'}`, flexShrink: 0 }} />}
              {clip && <span style={{ color: clip.saved ? '#34d399' : '#fbbf24', fontSize: 14, flexShrink: 0 }}>{clip.saved ? '✓' : '•'}</span>}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid #26262e', background: '#131318' }}>
        <span style={{ fontSize: 10.5, color: '#6b7280', flex: 1 }}>
          {r.captured === r.shots.length ? `All captured · ${r.savedCount}/${r.shots.length} on disk → captures/${session}` : `→ captures/${session} · survives refresh`}
        </span>
        <button onClick={() => Object.keys(r.clips).forEach((id, i) => setTimeout(() => r.download(id), i * 400))} disabled={r.captured === 0} style={{ padding: '6px 12px', background: r.captured ? ACCENT : '#2a2a32', border: 'none', borderRadius: 6, color: r.captured ? '#0f0f12' : '#5b5b66', fontSize: 11, fontWeight: 700, cursor: r.captured ? 'pointer' : 'default' }}>⤓ All</button>
      </div>
    </div>
  );
}
