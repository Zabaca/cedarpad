// Capture handoff: persist avatar-capture clips to disk so the next pipeline step
// (COLMAP -> msplat for geometry, or HeyGen/ElevenLabs ingestion for performance)
// can read them as plain files. The browser also keeps clips in IndexedDB for
// refresh-durability; this is the disk side so the work leaves the browser.
//
// Layout:  <CAPTURE_DIR>/<session>/<shot>.<ext>  +  <session>/manifest.json
// CAPTURE_DIR defaults to ~/cloner-poc/captures.

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.CAPTURE_DIR ?? join(homedir(), 'cloner-poc', 'captures');

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'x';

export interface ClipEntry {
  shot: string;
  file: string;
  mime: string;
  ext: string;
  duration: number;
  bytes: number;
  ts: number;
}
interface Manifest {
  session: string;
  updated: string;
  dir: string;
  clips: ClipEntry[];
}

async function readManifest(path: string, session: string, dir: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    return { session, updated: '', dir, clips: [] };
  }
}

export async function saveCapture(
  session: string,
  shot: string,
  mime: string,
  duration: number,
  bytes: ArrayBuffer,
): Promise<{ path: string; manifest: string; bytes: number }> {
  const dir = join(ROOT, sanitize(session));
  await mkdir(dir, { recursive: true });
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'bin';
  const file = join(dir, `${sanitize(shot)}.${ext}`);
  await Bun.write(file, bytes);

  const manifestPath = join(dir, 'manifest.json');
  const manifest = await readManifest(manifestPath, session, dir);
  manifest.session = session;
  manifest.dir = dir;
  manifest.updated = new Date().toISOString();
  manifest.clips = manifest.clips.filter((c) => c.shot !== shot);
  manifest.clips.push({ shot, file, mime, ext, duration, bytes: bytes.byteLength, ts: Date.now() });
  manifest.clips.sort((a, b) => a.shot.localeCompare(b.shot));
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  return { path: file, manifest: manifestPath, bytes: bytes.byteLength };
}

export async function listCaptures(session: string): Promise<ClipEntry[]> {
  const dir = join(ROOT, sanitize(session));
  const manifest = await readManifest(join(dir, 'manifest.json'), session, dir);
  return manifest.clips;
}

export const CAPTURE_ROOT = ROOT;
