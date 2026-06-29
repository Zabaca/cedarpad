// Geometry / Turnaround Capture — the OTHER capture setup: subject held rigid and
// neutral while the camera (or a swivel stool) orbits. Produces the multi-view
// coverage 3D Gaussian Splatting needs. Opposite of Performance Capture, where the
// subject moves and the camera is fixed — you cannot extract geometry from talking
// clips. Output (captures/<session>/) feeds frame-extract → COLMAP → msplat.
//
// Same persistence guarantees via useCaptureRig: IndexedDB (refresh-durable) + disk.

import { useMemo } from 'react';
import { useCaptureRig, fmt, type Shot } from './captureRig';

const ACCENT = '#34d399';

function shots(fullName: string): Shot[] {
  return [
    { id: 'consent', name: 'Consent', icon: '✋', target: 12, kind: 'script', frame: 'head',
      instruction: 'Read aloud, looking at the camera.',
      script: `I, ${fullName}, consent to the creation of a 3D AI clone of my likeness from the video I provide.` },
    { id: 'head_orbit', name: 'Head orbit · 360°', icon: '🔄', target: 40, kind: 'orbit', frame: 'head',
      instruction: 'HOLD A NEUTRAL EXPRESSION AND STAY STILL. Keep your head in the oval. Rotate slowly through a full 360° on a swivel stool (or have someone move the camera in a circle around your head). Smooth, even, no talking — geometry breaks if your face moves.' },
    { id: 'body_orbit', name: 'Full-body orbit · 360°', icon: '🧍', target: 45, kind: 'orbit', frame: 'body',
      instruction: 'Stand back so your WHOLE body fits the frame. Neutral, arms slightly away from your body, look ahead. Rotate slowly through a full 360°. Front / side / back frames are extracted from this pass for the reference sheet.' },
    { id: 'macro_eyes', name: 'Macro · eyes', icon: '👁️', target: 12, kind: 'macro', frame: 'macro',
      instruction: 'Move close to the camera. Hold still on your eyes / brow. Feeds identity-aware super-resolution (fine texture).' },
    { id: 'macro_skin', name: 'Macro · skin / profile', icon: '🔬', target: 12, kind: 'macro', frame: 'macro',
      instruction: 'Close-up of cheek / jaw / skin texture, then slow turn to profile. Captures fine surface detail.' },
  ];
}

const iconBtn: any = { width: 24, height: 24, padding: 0, background: '#22241f', border: 'none', borderRadius: 5, color: '#d1d5db', fontSize: 11, cursor: 'pointer', flexShrink: 0 };

export default function GeometryCapture({
  fullName = 'James [Last Name]', session = 'james-geometry',
}: { fullName?: string; session?: string }) {
  const SHOTS = useMemo(() => shots(fullName), [fullName]);
  const r = useCaptureRig(session, SHOTS);
  const { shot } = r;
  const frame = shot?.frame ?? 'head';
  const isOrbit = frame === 'head' || frame === 'body';
  const guideStroke = r.recId ? '#ef4444' : ACCENT;
  const caption = frame === 'body' ? 'Fit your WHOLE body in the frame'
    : frame === 'macro' ? 'Move in — fill the frame'
    : 'Keep your head in the oval';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f120f', color: '#f3f4f6', fontFamily: 'system-ui, sans-serif', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#151a15', borderBottom: '1px solid #24302a' }}>
        <span style={{ fontSize: 14 }}>🧊</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Geometry / Turnaround</span>
        <span style={{ fontSize: 9.5, color: ACCENT, border: `1px solid ${ACCENT}55`, borderRadius: 10, padding: '1px 6px' }}>3DGS</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#8b8b96' }}>{r.captured}/{r.shots.length} · {r.savedCount} saved</span>
        <div style={{ width: 56, height: 5, background: '#24302a', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${(r.captured / r.shots.length) * 100}%`, height: '100%', background: ACCENT, transition: 'width .3s' }} />
        </div>
      </div>

      {/* Preview */}
      <div style={{ position: 'relative', background: '#000', aspectRatio: '4/3' }}>
        <canvas ref={r.canvasRef} style={{ width: '100%', height: '100%', objectFit: 'cover', display: r.ready && !r.reviewId ? 'block' : 'none', transform: 'scaleX(-1)' }} />
        <video ref={r.videoRef} playsInline controls style={{ width: '100%', height: '100%', objectFit: 'cover', display: r.reviewId ? 'block' : 'none' }} />
        <video ref={r.rawVideoRef} playsInline muted style={{ display: 'none' }} />

        {/* Adaptive framing guide — shape depends on what the shot needs in frame */}
        {r.ready && !r.reviewId && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {frame === 'body' && <rect x="31" y="5" width="38" height="90" rx="5" fill="none" stroke={guideStroke} strokeWidth="0.5" strokeDasharray="2 1.5" opacity="0.75" />}
            {(frame === 'head' || frame === 'face') && <ellipse cx="50" cy="42" rx="21" ry="28" fill="none" stroke={guideStroke} strokeWidth="0.5" strokeDasharray="2 1.5" opacity="0.8" />}
            {frame === 'macro' && <circle cx="50" cy="50" r="15" fill="none" stroke={guideStroke} strokeWidth="0.6" strokeDasharray="2 1.5" opacity="0.85" />}
            {isOrbit && <>
              <path d="M 50 2.5 A 47.5 47.5 0 0 1 90 50" fill="none" stroke={ACCENT} strokeWidth="0.5" opacity="0.45" />
              <path d="M 88 44 L 91 51 L 84 50 Z" fill={ACCENT} opacity="0.55" />
            </>}
          </svg>
        )}

        {/* What to fit in frame + rigid-hold reminder */}
        {r.ready && !r.reviewId && (
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,.62)', padding: '3px 10px', borderRadius: 12, fontSize: 10.5, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>{caption}</div>
        )}
        {r.ready && !r.reviewId && isOrbit && (
          <div style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,.55)', padding: '3px 8px', borderRadius: 12, fontSize: 10, color: ACCENT, fontWeight: 700 }}>HOLD NEUTRAL · ROTATE</div>
        )}

        {r.recId && (
          <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,.55)', padding: '4px 9px', borderRadius: 20 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#ef4444' }} />
            <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.elapsed)}</span>
            <span style={{ fontSize: 11, color: r.reachedTarget ? ACCENT : '#d1d5db' }}>/ {fmt(shot.target)} {r.reachedTarget ? '✓' : ''}</span>
          </div>
        )}
        {r.reviewId && (
          <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,.55)', padding: '4px 9px', borderRadius: 20, fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>▶ {r.shots.find(s => s.id === r.reviewId)?.name}</div>
        )}

        {r.ready && !r.reviewId && shot && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 12px', background: 'linear-gradient(transparent, rgba(0,0,0,.85))' }}>
            {shot.script
              ? <div style={{ fontSize: 14, lineHeight: 1.5, fontWeight: 600, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,.8)' }}>“{shot.script}”</div>
              : <div style={{ fontSize: 11.5, lineHeight: 1.45, color: '#e5e7eb' }}>{shot.instruction}</div>}
          </div>
        )}

        {!r.ready && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }}>
            <div style={{ fontSize: 40 }}>🧊</div>
            <button onClick={r.enableCam} style={{ padding: '8px 18px', background: ACCENT, border: 'none', borderRadius: 7, color: '#0f120f', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Enable camera & mic</button>
            <span style={{ fontSize: 10, color: '#6b7280', textAlign: 'center', maxWidth: 260 }}>Tip: even, diffuse light · plain background · subject rigid, camera (or stool) moves. Saved on device + synced to disk.</span>
            {r.camErr && <span style={{ fontSize: 11, color: '#ef4444', textAlign: 'center' }}>{r.camErr}</span>}
          </div>
        )}
      </div>

      {/* Zoom (digital — baked into the recording; fill the frame with your head) */}
      {r.ready && !r.reviewId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: '#121712', borderBottom: '1px solid #24302a' }}>
          <span style={{ fontSize: 11, color: '#8b8b96' }}>🔍 Zoom</span>
          <input type="range" min="1" max="4" step="0.1" value={r.zoom} onChange={e => r.setZoom(parseFloat(e.target.value))} style={{ flex: 1, accentColor: ACCENT }} />
          <span style={{ fontSize: 11, color: '#d1d5db', width: 30, textAlign: 'right' }}>{r.zoom.toFixed(1)}×</span>
        </div>
      )}

      {/* Record controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #24302a', background: '#121712' }}>
        {!r.recId ? (
          <button onClick={r.startRec} disabled={!r.ready} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', background: r.ready ? '#ef4444' : '#222a22', border: 'none', borderRadius: 7, color: r.ready ? '#fff' : '#5b6b5b', fontSize: 13, fontWeight: 700, cursor: r.ready ? 'pointer' : 'default' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.ready ? '#fff' : '#5b6b5b' }} />
            Record {shot ? `“${shot.name}”` : ''}
          </button>
        ) : (
          <button onClick={r.stopRec} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', background: '#fff', border: 'none', borderRadius: 7, color: '#0f120f', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444' }} />
            Stop {r.reachedTarget ? '· enough' : '· keep rotating'}
          </button>
        )}
        <div style={{ flex: 1, height: 6, background: '#24302a', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${r.pct * 100}%`, height: '100%', background: r.reachedTarget ? ACCENT : '#86efac', transition: 'width .15s linear' }} />
        </div>
        {r.reviewId && <button onClick={r.backToCam} style={{ padding: '6px 10px', background: '#222a22', border: 'none', borderRadius: 6, color: '#d1d5db', fontSize: 11, cursor: 'pointer' }}>↩ Live</button>}
      </div>

      {/* Shot list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {r.shots.map((s, i) => {
          const clip = r.clips[s.id];
          const isActive = i === r.active, isRec = r.recId === s.id, isSync = r.syncing === s.id;
          const statusText = isRec ? 'recording…' : isSync ? 'saving to disk…' : clip ? (clip.saved ? `saved · ${fmt(clip.duration)}` : `on device · ${fmt(clip.duration)}`) : 'not captured';
          const statusColor = isRec ? '#ef4444' : isSync ? '#fbbf24' : clip ? (clip.saved ? ACCENT : '#fbbf24') : '#6b7280';
          return (
            <div key={s.id} onClick={() => !r.recId && r.setActive(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', margin: '3px 0', borderRadius: 8, cursor: r.recId ? 'default' : 'pointer', background: isActive ? '#19211a' : 'transparent', border: `1px solid ${isActive ? ACCENT + '55' : 'transparent'}` }}>
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
              {!clip && <span style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${isActive ? ACCENT : '#3a443a'}`, flexShrink: 0 }} />}
              {clip && <span style={{ color: clip.saved ? ACCENT : '#fbbf24', fontSize: 14, flexShrink: 0 }}>{clip.saved ? '✓' : '•'}</span>}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid #24302a', background: '#121712' }}>
        <span style={{ fontSize: 10.5, color: '#6b7280', flex: 1 }}>
          {r.captured === r.shots.length ? `All captured → captures/${session} → COLMAP → msplat` : `→ captures/${session} → COLMAP → msplat`}
        </span>
        <button onClick={() => Object.keys(r.clips).forEach((id, i) => setTimeout(() => r.download(id), i * 400))} disabled={r.captured === 0} style={{ padding: '6px 12px', background: r.captured ? ACCENT : '#222a22', border: 'none', borderRadius: 6, color: r.captured ? '#0f120f' : '#5b6b5b', fontSize: 11, fontWeight: 700, cursor: r.captured ? 'pointer' : 'default' }}>⤓ All</button>
      </div>
    </div>
  );
}
