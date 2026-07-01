// Shared capture engine for the avatar capture components (Performance + Geometry).
//
// Durability guarantees the UI components rely on:
//  1) Survives refresh  — every clip is written to IndexedDB the instant recording
//     stops, and rehydrated on mount. Nothing is lost on reload.
//  2) Leaves the browser — every clip is also uploaded to /api/capture/save, which
//     writes it to disk (~/cloner-poc/captures/<session>/) for the next pipeline step.
//
// Zoom: the camera is piped through a <canvas> (center-crop = digital zoom) and the
// RECORDING is captured from that canvas, so zoom is baked into the saved clip (a CSS
// zoom would only change the preview, not the file). Digital zoom upscales — it helps
// framing, not true detail; for real detail, move closer.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Shot {
  id: string; name: string; icon: string; target: number;
  instruction: string; script?: string; kind?: string; frame?: string;
}
export interface ClipState {
  duration: number; mime: string; url: string;
  saved: boolean; savedPath?: string; bytes?: number;
}
type ClipRec = ClipState & { blob?: Blob };

// ---------------- IndexedDB ----------------
const DB = 'cloner-captures', STORE = 'clips';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const kk = (s: string, shot: string) => `${s}::${shot}`;
async function idbPut(s: string, shot: string, rec: any) {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec, kk(s, shot));
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function idbAll(s: string): Promise<any[]> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly'); const out: any[] = [];
    const cur = tx.objectStore(STORE).openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { if (String(c.key).startsWith(s + '::')) out.push(c.value); c.continue(); } else res(out); };
    cur.onerror = () => rej(cur.error);
  });
}
async function idbDel(s: string, shot: string) {
  const db = await idb();
  await new Promise<void>((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(kk(s, shot)); tx.oncomplete = () => res(); });
}

// ---------------- helpers ----------------
export function fmt(s: number) { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${r.toString().padStart(2, '0')}`; }
function pickMime(): string | undefined {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const o of opts) { try { if ((window as any).MediaRecorder?.isTypeSupported?.(o)) return o; } catch {} }
  return undefined;
}
const strip = (m: Record<string, ClipRec>): Record<string, ClipState> => {
  const o: Record<string, ClipState> = {};
  for (const k in m) { const { blob, ...rest } = m[k]; o[k] = rest; }
  return o;
};

export function useCaptureRig(session: string, shots: Shot[]) {
  const canvasRef = useRef<HTMLCanvasElement>(null);   // visible live preview + recording source
  const rawVideoRef = useRef<HTMLVideoElement>(null);  // hidden: raw camera feed
  const videoRef = useRef<HTMLVideoElement>(null);     // visible only while reviewing a clip
  const streamRef = useRef<MediaStream | null>(null);
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const elapsedRef = useRef(0);
  const zoomRef = useRef(1);
  const clipsRef = useRef<Record<string, ClipRec>>({});

  const [ready, setReady] = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recId, setRecId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [zoom, setZoomState] = useState(1);
  const [clips, setClips] = useState<Record<string, ClipState>>({});
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const shot = shots[active];

  const setZoom = useCallback((z: number) => { zoomRef.current = Math.max(1, Math.min(4, z)); setZoomState(zoomRef.current); }, []);

  // Continuously draw the (zoomed) camera into the canvas — this is both the preview
  // and the source MediaRecorder records from.
  const drawLoop = useCallback(() => {
    const v = rawVideoRef.current, c = canvasRef.current;
    if (v && c && v.videoWidth) {
      if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
      const ctx = c.getContext('2d');
      if (ctx) {
        const z = zoomRef.current;
        const sw = v.videoWidth / z, sh = v.videoHeight / z;
        ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
      }
    }
    rafRef.current = requestAnimationFrame(drawLoop);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const recs = await idbAll(session);
        if (!alive) return;
        const next: Record<string, ClipRec> = {};
        for (const r of recs) {
          if (!r?.blob) continue;
          next[r.shot] = { duration: r.duration, mime: r.mime, url: URL.createObjectURL(r.blob), saved: !!r.saved, savedPath: r.savedPath, bytes: r.blob.size, blob: r.blob };
        }
        clipsRef.current = next;
        setClips(strip(next));
      } catch {}
    })();
    return () => { alive = false; };
  }, [session]);

  const upload = useCallback(async (shotId: string, blob: Blob, mime: string, duration: number) => {
    setSyncing(shotId);
    try {
      const fd = new FormData();
      fd.append('file', blob, `${shotId}.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
      fd.append('session', session); fd.append('shot', shotId);
      fd.append('mime', mime); fd.append('duration', String(Math.round(duration)));
      const res = await fetch('/api/capture/save', { method: 'POST', body: fd });
      const j = await res.json().catch(() => null);
      if (j?.ok) {
        const rec = clipsRef.current[shotId];
        if (rec) {
          rec.saved = true; rec.savedPath = j.path;
          clipsRef.current = { ...clipsRef.current, [shotId]: rec };
          setClips(strip(clipsRef.current));
          await idbPut(session, shotId, { session, shot: shotId, blob: rec.blob, mime, duration, ts: Date.now(), saved: true, savedPath: j.path });
        }
      }
    } catch {}
    finally { setSyncing(null); }
  }, [session]);

  const enableCam = useCallback(async () => {
    setCamErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream; setReady(true);
      const rv = rawVideoRef.current;
      if (rv) { rv.srcObject = stream; rv.muted = true; await rv.play().catch(() => {}); }
      if (rafRef.current == null) drawLoop();
    } catch (e: any) { setCamErr(e?.message ?? 'Camera/mic access denied'); }
  }, [drawLoop]);

  const startRec = useCallback(() => {
    const c = canvasRef.current, stream = streamRef.current;
    if (!c || !stream || recId) return;
    setReviewId(null);
    chunksRef.current = [];
    const cstream = c.captureStream(30);
    const at = stream.getAudioTracks()[0]; if (at) cstream.addTrack(at);
    const mime = pickMime();
    const mr = new MediaRecorder(cstream, mime ? { mimeType: mime } : undefined);
    mrRef.current = mr;
    mr.ondataavailable = e => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    const id = shot.id;
    mr.onstop = async () => {
      const mt = mr.mimeType || 'video/webm';
      const blob = new Blob(chunksRef.current, { type: mt });
      const prev = clipsRef.current[id]; if (prev?.url) URL.revokeObjectURL(prev.url);
      const rec: ClipRec = { duration: elapsedRef.current, mime: mt, url: URL.createObjectURL(blob), saved: false, bytes: blob.size, blob };
      clipsRef.current = { ...clipsRef.current, [id]: rec };
      setClips(strip(clipsRef.current));
      await idbPut(session, id, { session, shot: id, blob, mime: mt, duration: elapsedRef.current, ts: Date.now(), saved: false });
      upload(id, blob, mt, elapsedRef.current);
      const nextIdx = shots.findIndex(s => !clipsRef.current[s.id]);
      if (nextIdx !== -1) setActive(nextIdx);
    };
    mr.start();
    setRecId(id);
    elapsedRef.current = 0; setElapsed(0);
    timerRef.current = setInterval(() => { elapsedRef.current += 0.1; setElapsed(elapsedRef.current); }, 100);
  }, [recId, shot, session, shots, upload]);

  const stopRec = useCallback(() => {
    try { mrRef.current?.stop(); } catch {}
    clearInterval(timerRef.current); timerRef.current = null;
    setRecId(null);
  }, []);

  const review = useCallback((id: string) => {
    const clip = clipsRef.current[id]; if (!clip || recId) return;
    setReviewId(id);
    const rv = videoRef.current;
    if (rv) { rv.src = clip.url; rv.muted = false; rv.currentTime = 0; rv.play().catch(() => {}); }
  }, [recId]);

  const backToCam = useCallback(() => {
    setReviewId(null);
    try { videoRef.current?.pause(); } catch {}
  }, []);

  const download = useCallback((id: string) => {
    const clip = clipsRef.current[id]; if (!clip) return;
    const ext = clip.mime.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = clip.url; a.download = `${session}-${id}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
  }, [session]);

  const remove = useCallback(async (id: string) => {
    const prev = clipsRef.current[id]; if (prev?.url) URL.revokeObjectURL(prev.url);
    const { [id]: _, ...rest } = clipsRef.current; clipsRef.current = rest; setClips(strip(rest));
    await idbDel(session, id);
  }, [session]);

  const reSync = useCallback((id: string) => {
    const rec = clipsRef.current[id]; if (rec?.blob) upload(id, rec.blob, rec.mime, rec.duration);
  }, [upload]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    try { mrRef.current?.stop(); } catch {}
    streamRef.current?.getTracks().forEach(t => t.stop());
    Object.values(clipsRef.current).forEach(c => c.url && URL.revokeObjectURL(c.url));
  }, []);

  const captured = Object.keys(clips).length;
  const savedCount = Object.values(clips).filter(c => c.saved).length;
  const pct = shot ? Math.min(1, elapsed / shot.target) : 0;
  const reachedTarget = elapsed >= (shot?.target ?? 1e9);

  return {
    canvasRef, rawVideoRef, videoRef,
    ready, camErr, enableCam,
    active, setActive, shot, shots,
    recId, elapsed, startRec, stopRec, pct, reachedTarget,
    zoom, setZoom,
    clips, captured, savedCount, syncing,
    reviewId, review, backToCam, download, remove, reSync,
    session,
  };
}
