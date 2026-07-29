// Data-loss guards for the tar-backed Persistables (ADR 0003 sink).
//
// WHY THIS EXISTS — the 2026-07-29 loss. Every canvas's own-tier components, every
// custom handler, and every workspace skill were destroyed in one flush. The mechanism:
//
//   1. ONE R2 key holds the whole artifact (`workspaces/<ws>/canvas-components.tar`).
//   2. Saving is a FULL REPLACE of whatever is on disk right now
//      (`serialize: () => tarCanvasDirs(SRC_ROOT)`).
//   3. A failed restore at boot is SWALLOWED — container-start.ts logs
//      "starting with none" and carries on.
//
// So a boot that restores nothing comes up with an empty tree, and the next write tars
// that empty tree over the only good copy. Silent, instant, workspace-wide, and with no
// second copy anywhere. `blob-store.ts` notes that the canvas-state guard which used to
// cover this class of bug "went with the old sync plane (ADR-0019 / #297)"; nothing
// replaced it, and the tar sinks never had one.
//
// THE RULE: an empty tarball never overwrites an existing blob. A full-replace save is
// the write half of a read-modify-write, and an empty tree is indistinguishable from
// "we failed to read the baseline" — so it is never safe to trust.
//
// ACCEPTED COST: legitimately deleting the LAST item of an artifact does not persist —
// the blob keeps the previous contents until something else is written. That is a rare,
// reversible staleness, traded against an unrecoverable, silent, total loss. The skip is
// loud (console + `lastResult: 'skipped'` at /api/status), never silent.
//
// Deliberately NOT a general "catastrophic shrink" guard (e.g. refuse 100 files → 1):
// that needs the remote to compare against, and `BlobBackend` has no head/size — reading
// it per flush would pull sessions.tar (49MB at the time of writing) on every turn.
// Empty-vs-non-empty is the failure that actually happened and is unambiguous.

/** A tar entry we care about: its path and whether it holds file content. */
export interface TarEntry {
  name: string;
  size: number;
  /** POSIX typeflag: '0'/'\0' regular file, '5' directory, 'L' GNU long name, … */
  type: string;
}

const BLOCK = 512;
const decoder = new TextDecoder();
const field = (b: Uint8Array, from: number, to: number): string =>
  decoder.decode(b.slice(from, to)).replace(/\0.*$/s, '').trim();

/** Parse POSIX tar headers. Tolerant by design: a malformed or truncated archive yields
 *  the entries read so far rather than throwing, because this runs inside a save guard —
 *  it must never be the reason a legitimate write fails. */
export function tarEntries(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const name = field(bytes, off, off + 100);
    if (!name) break; // end-of-archive zero block
    const size = Number.parseInt(field(bytes, off + 124, off + 136) || '0', 8);
    if (!Number.isFinite(size) || size < 0) break;
    out.push({ name, size, type: field(bytes, off + 156, off + 157) || '0' });
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/** Placeholder files that keep an empty dir in git but carry no workspace content — an
 *  archive holding only these is still semantically empty. */
const PLACEHOLDERS = new Set(['.gitkeep', '.gitignore']);

/** Does this tarball carry real content? Directory entries and placeholders don't count:
 *  a tar of three empty `canvas-<id>/components/` dirs is exactly what the 2026-07-29
 *  loss wrote, and it must read as empty. */
export function tarHasContent(bytes: Uint8Array): boolean {
  return tarEntries(bytes).some((e) => {
    if (e.type === '5' || e.name.endsWith('/')) return false; // directory
    const base = e.name.split('/').pop() ?? '';
    return !PLACEHOLDERS.has(base);
  });
}

/**
 * A `Persistable.guard` that refuses to replace an existing blob with an empty tarball.
 *
 * `exists` is injected (rather than reading the blob) so the check costs one HEAD-shaped
 * call, not a download — see the note above about sessions.tar. When the blob does not
 * exist yet there is nothing to lose, so an empty first write is allowed through: a brand
 * new workspace legitimately has no components.
 */
export function refuseEmptyTarball(
  name: string,
  exists: () => Promise<boolean>,
  log: (msg: string) => void = console.error,
): (bytes: Uint8Array) => Promise<boolean> {
  return async (bytes) => {
    if (tarHasContent(bytes)) return true;
    if (!(await exists())) return true; // nothing on the other side to destroy
    log(
      `[persist] REFUSED to overwrite ${name} with an empty archive — the source tree is empty ` +
        `but the stored blob is not. This is the 2026-07-29 data-loss shape: a boot that failed ` +
        `to restore, about to flush nothing over everything. The stored blob is UNCHANGED. ` +
        `Check the restore path (container-start.ts) before writing to this artifact again.`,
    );
    return false;
  };
}
