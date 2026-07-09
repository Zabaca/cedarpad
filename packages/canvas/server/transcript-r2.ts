// Transcript backup/restore to R2 (PRD #50 / ADR-0007, slice #60). The SDK writes the
// authoritative conversation to ~/.claude/projects/<projectDir>/<sessionId>.jsonl for
// `resume`. This module mirrors that JSONL to R2 so a session's history survives runner
// sleep. Three flows, same R2-as-runtime-delta pattern as ADR-0001:
//   backup(sessionId)  — container FS → R2 (idempotent overwrite; handles a growing file)
//   restore(sessionId) — R2 → container FS, reconstructing the exact path resume needs
//   read(sessionId)    — R2 → rendered history (the Inbox UI, while the runner sleeps)
//
// The key derivation is a pure fn of sessionId and the read seam is a one-method `BlobGetter`
// so both sides agree: the container passes its Bun-S3 `BlobBackend`; the edge worker (#62)
// implements `BlobGetter` against its own R2 access and reads with just the sessionId.

import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ChatEvent } from '../shared/chat-wire.ts';
import { projectJsonl } from './session-transcript.ts';

/** Read seam for the R2 blob. `get` returns null for an absent key. `BlobBackend`
 * (blob-store.ts) satisfies this structurally, so the container reuses it as-is; the edge
 * (#62) supplies its own tiny implementation. */
export interface BlobGetter {
  get(key: string): Promise<Uint8Array | null>;
}

/** Write seam for backup. `BlobBackend` satisfies it structurally. */
export interface BlobPutter {
  put(key: string, data: Uint8Array): Promise<void>;
}

/** Pure, stable R2 key for a session's transcript. Global (keyed by the SDK's
 * already-unique sessionId), NOT workspace-scoped: the Inbox is user-scoped and aggregates
 * Conversations across workspaces, so the edge read path resolves history from sessionId
 * alone (CONTEXT.md → Inbox → Storage). */
export const transcriptKey = (sessionId: string): string => `sessions/${sessionId}/transcript.jsonl`;

/** Pure: the SDK's on-disk project-dir name for a cwd. Claude Code encodes the absolute cwd
 * into a single dir segment by replacing every `/` and `.` with `-` (e.g. `/workspace/app`
 * → `-workspace-app`), so `resume` reads `<projectsDir>/<encoded>/<sessionId>.jsonl`. Restore
 * must land the file at exactly that path. */
export const projectDirForCwd = (cwd: string): string => cwd.replace(/[/.]/g, '-');

/** Locate + read the raw session JSONL bytes on disk. Globs `**\/<sessionId>.jsonl` (same as
 * loadSessionTranscript) so it is robust to nesting; an absent file yields null. Returns the
 * raw bytes — restore must reproduce them verbatim, so we do NOT project here. */
export async function readRawTranscript(projectsDir: string, sessionId: string): Promise<Uint8Array | null> {
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }
  return null;
}

/** Container-side: mirror a session's on-disk JSONL to R2. Idempotent — a re-backup of a
 * grown transcript overwrites the blob with the latest bytes. Returns whether anything was
 * written (false when the session file is absent). */
export async function backup(putter: BlobPutter, projectsDir: string, sessionId: string): Promise<boolean> {
  const bytes = await readRawTranscript(projectsDir, sessionId);
  if (bytes === null) return false;
  await putter.put(transcriptKey(sessionId), bytes);
  return true;
}

/** ADR-0010 slice 6: MOVE a session's JSONL into the project dir for `cwd`, so
 * `query({ resume, cwd })` finds it once the dev-agent turn's cwd moves to its prepared
 * worktree (the SDK resume is cwd-scoped, #133 — the batch explore session was written under
 * CANVAS_CWD, and a cold-boot restore re-lands it there). A move, never a copy: the
 * transcript loader concatenates every glob match, so a duplicate would double history.
 * Idempotent, dest-wins: once turns run under the worktree the SDK appends at dest, so any
 * copy elsewhere is a stale restore artifact (⊆ dest at its last backup) and is culled.
 * Returns the dest path, or null when the session has no JSONL anywhere (a fresh session). */
export async function adoptSession(projectsDir: string, sessionId: string, cwd: string): Promise<string | null> {
  const dest = join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`);
  const found: string[] = [];
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) found.push(path);
  if (found.length === 0) return null;

  const others = found.filter((p) => p !== dest);
  if (others.length === found.length) {
    // Not home yet: move the (single, in practice) copy to dest.
    await mkdir(dirname(dest), { recursive: true });
    await rename(others.shift()!, dest);
  }
  for (const stale of others) await rm(stale, { force: true });
  return dest;
}

/** Container-side: pull a session's JSONL from R2 back onto the runner FS at the exact path
 * the SDK resume expects — `<projectsDir>/<projectDirForCwd(cwd)>/<sessionId>.jsonl`. Returns
 * the written path, or null if R2 has no transcript for the session. */
export async function restore(
  getter: BlobGetter,
  projectsDir: string,
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const bytes = await getter.get(transcriptKey(sessionId));
  if (bytes === null) return null;
  const path = join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`);
  await Bun.write(path, bytes);
  return path;
}

/** Edge/container: fetch a session's raw JSONL from R2. null when absent. */
export async function readRaw(getter: BlobGetter, sessionId: string): Promise<string | null> {
  const bytes = await getter.get(transcriptKey(sessionId));
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Edge/container: fetch + project a session's transcript from R2 into replay events for the
 * Inbox UI. An absent transcript yields `[]` (not an error), matching loadSessionTranscript. */
export async function read(getter: BlobGetter, sessionId: string): Promise<ChatEvent[]> {
  const text = await readRaw(getter, sessionId);
  return text === null ? [] : projectJsonl(text);
}
