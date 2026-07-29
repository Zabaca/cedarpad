// Thin orchestration entrypoint for the warehouse container (ADR-0017, #237): read the stored
// session Transcripts from R2, materialize mart_session_events, write the parquet + its
// declared-schema sidecar back to R2. What a future Materialize Job (#240, out of scope here —
// job dispatch/scheduling is a separate slice) would invoke one-shot; this file has no
// scheduling of its own.
//
// #356: the source is one object per session (`sessions/<id>/transcript.jsonl`), not a
// `sessions.tar`. Transcript keys are global by design — the Inbox is user-scoped and resolves
// history from a sessionId alone (transcript-store.ts) — so `ws` scopes only where the MART is
// written, not which sessions it covers. The mart's description states that scope.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type BlobBackend, BlobStore, s3Backend } from '../server/blob-store.ts';
import { TranscriptStore } from '../server/transcript-store.ts';
import { MART_NAME, materializeSessionEventsMart } from './session-events-mart.ts';

/** Read every stored session Transcript, materialize mart_session_events, and write the mart +
 * sidecar back to R2 under `workspaces/<ws>/warehouse/`. Returns `null` when no session has a
 * stored transcript (nothing to materialize — not an error). Worktree-safe (CLAUDE.md §6): the
 * working dir is a fresh `mkdtemp`, never a fixed path, so a parallel run never collides. */
export async function materializeWorkspace(backend: BlobBackend, ws: string): Promise<{ rowCount: number } | null> {
  const store = new BlobStore(backend);
  // `projectsDir` is unused on this path — the warehouse only ever reads objects, never the
  // runner FS (it does not have one).
  const transcripts = new TranscriptStore(backend, '');
  const sessionIds = await transcripts.listSessions();
  if (sessionIds.length === 0) return null;

  const workDir = await mkdtemp(join(tmpdir(), 'cedarpad-warehouse-'));
  try {
    const sessionsDir = join(workDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    for (const sessionId of sessionIds) {
      const bytes = await transcripts.get(sessionId);
      if (bytes !== null) await Bun.write(join(sessionsDir, `${sessionId}.jsonl`), bytes);
    }
    const { parquet, sidecar } = await materializeSessionEventsMart(sessionsDir, workDir);
    await store.saveMart(ws, MART_NAME, parquet);
    await store.saveMartSidecar(ws, MART_NAME, sidecar);
    return { rowCount: sidecar.rowCount };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const ws = process.env.CANVAS_WORKSPACE ?? 'default';
  const result = await materializeWorkspace(s3Backend(), ws);
  if (result === null) {
    console.log(`materialize: no stored session transcripts yet for workspace "${ws}" — nothing to do.`);
  } else {
    console.log(`materialize: wrote ${MART_NAME} for workspace "${ws}" (${result.rowCount} rows).`);
  }
}
