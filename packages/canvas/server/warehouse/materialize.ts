// Thin orchestration entrypoint for the warehouse container (ADR-0017, #237): read this
// workspace's sessions.tar from R2, materialize mart_session_events, write the parquet +
// its declared-schema sidecar back to R2. What a future Materialize Job (#240, out of scope
// here — job dispatch/scheduling is a separate slice) would invoke one-shot; this file has
// no scheduling of its own.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type BlobBackend, BlobStore, s3Backend } from '../blob-store.ts';
import { MART_NAME, materializeSessionEventsMart } from './session-events-mart.ts';

/** Read sessions.tar, materialize mart_session_events, and write the mart + sidecar back to
 * R2 under `workspaces/<ws>/warehouse/`. Returns `null` if the workspace has no sessions.tar
 * yet (nothing to materialize — not an error). Worktree-safe (CLAUDE.md §6): the working dir
 * is a fresh `mkdtemp`, never a fixed path, so a parallel materialize run never collides. */
export async function materializeWorkspace(backend: BlobBackend, ws: string): Promise<{ rowCount: number } | null> {
  const store = new BlobStore(backend);
  const tar = await store.loadSessions(ws);
  if (tar === null) return null;

  const workDir = await mkdtemp(join(tmpdir(), 'cedarpad-warehouse-'));
  try {
    const { parquet, sidecar } = await materializeSessionEventsMart(tar, workDir);
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
    console.log(`materialize: workspace "${ws}" has no sessions.tar yet — nothing to do.`);
  } else {
    console.log(`materialize: wrote ${MART_NAME} for workspace "${ws}" (${result.rowCount} rows).`);
  }
}
