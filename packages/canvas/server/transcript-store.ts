// Session Transcripts: one opaque R2 object per session (PRD #50 / ADR-0007 slice #60;
// per-session granularity made authoritative in #356 / ADR-0022). The SDK writes the
// authoritative conversation to ~/.claude/projects/<projectDir>/<sessionId>.jsonl for
// `resume`; this module mirrors that JSONL to R2 so a session's history survives runner sleep.
//
// `TranscriptStore` (bottom of the file) is the container's interface — put one session,
// materialize one session. The free functions above it are the pieces it is built from.
//
// A Transcript is a FILE, not a Record (CONTEXT.md → Record vs File): the Claude Agent SDK owns
// the format and reads it back on `--resume`, so the bytes are opaque here — never parsed,
// normalised or re-encoded. Round-trip fidelity IS the contract; a subtly wrong one breaks
// conversation continuity silently.

import { findSessionJsonl, resumeJsonlPath } from './session-jsonl.ts';

// projectDirForCwd's canonical home is now session-jsonl.ts (the one home for a session's
// JSONL-path knowledge); re-exported here for existing importers.
export { projectDirForCwd } from './session-jsonl.ts';

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

/** The key a session's transcript had in the bucket when this store wrote it directly: global (keyed
 * by the SDK's already-unique sessionId), NOT workspace-scoped. A container no longer reaches the
 * bucket (`edgeBackend`, shared/workspace-blob.ts): it names this key and the edge stores the
 * transcript under `workspaces/<ws>/sessions/<id>/`, falling back to this flat key only to read the
 * legacy `default` workspace's old ones. */
export const transcriptKey = (sessionId: string): string => `sessions/${sessionId}/transcript.jsonl`;

/** Locate + read the raw session JSONL bytes on disk (nesting-robust via findSessionJsonl); an
 * absent file yields null. Returns the raw bytes — restore must reproduce them verbatim, so we
 * do NOT project here. */
export async function readRawTranscript(projectsDir: string, sessionId: string): Promise<Uint8Array | null> {
  const [path] = await findSessionJsonl(projectsDir, sessionId);
  return path ? new Uint8Array(await Bun.file(path).arrayBuffer()) : null;
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
  const path = resumeJsonlPath(projectsDir, cwd, sessionId);
  await Bun.write(path, bytes);
  return path;
}

/** The blob seam `TranscriptStore` needs: get + put (one session). `BlobBackend` satisfies it
 * structurally, so the container passes its Bun-S3 backend as-is and tests pass `memBackend()`
 * — the same precedent blob-store.ts set. */
export type TranscriptBlobs = BlobGetter & BlobPutter;

/**
 * The container's custodian of session Transcripts (#356, ADR-0022 decision 7). A Transcript is
 * a **File**, not a Record: the Claude Agent SDK owns its format and reads it back on `--resume`,
 * so we store it as one opaque object per session and never parse, normalise or re-encode it.
 *
 * The interface is three verbs, because granularity is the whole point:
 *   put(sessionId)              — after a turn, write ONLY the session that turn touched.
 *   materialize(sessionId, cwd) — before a resume, fetch ONLY that session.
 *   get                         — read seam: a session's raw stored bytes.
 *
 * What it replaces: a `sessions.tar` of the whole `~/.claude/projects` tree, re-uploaded every
 * turn (49,111,040 bytes in production against ~650 KB of appends) and re-downloaded at every
 * cold boot. Nothing here touches boot.
 */
export class TranscriptStore {
  constructor(
    private readonly blobs: TranscriptBlobs,
    /** `~/.claude/projects` on the runner — where the SDK writes and resume reads. */
    private readonly projectsDir: string,
  ) {}

  /** Write the one session this turn touched. False (and NO write) when the session has no
   * JSONL on disk: an absent local file must never become an empty object over a good one —
   * that inversion is the 2026-07-29 loss, and this path must not reintroduce it. */
  put(sessionId: string): Promise<boolean> {
    return backup(this.blobs, this.projectsDir, sessionId);
  }

  /** A session's raw stored bytes, or null when absent. */
  get(sessionId: string): Promise<Uint8Array | null> {
    return this.blobs.get(transcriptKey(sessionId));
  }

  /** Ensure the ONE session a resume is about to read is on the runner FS, at the exact
   * cwd-scoped path `query({ resume, cwd })` expects. Returns the path, or null when the session
   * is nowhere (a fresh session — the SDK will start one). Two rules:
   *   - Fetches nothing else. This is what makes resume cost proportional to one session rather
   *     than to workspace history, and what lets boot download nothing at all.
   *   - A local copy WINS. On a warm runner the SDK has been appending since the last put, so
   *     disk is authoritative; overwriting it would rewind the conversation, and writing a
   *     second copy would double it (the transcript loader concatenates every glob match).
   * A `projectsDir` that does not exist yet (a cold container) is "not present", not an error. */
  async materialize(sessionId: string, cwd: string): Promise<string | null> {
    const local = await findSessionJsonl(this.projectsDir, sessionId).catch(() => []);
    if (local.length > 0) return local[0]!;
    return restore(this.blobs, this.projectsDir, cwd, sessionId);
  }
}
