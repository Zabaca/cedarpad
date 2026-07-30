// Workspace overlay = the whole package subtree (minus the excludes) tarred to
// the blob store, so a fresh container restores every file the agent touched —
// however it was written (Bash/Write/Edit, not just write_component). No diff:
// the tar IS the current state, so restore replaces the subtree and deletions
// are honored. Container-only (gated on R2 in the entry); IO, not unit-policy.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Rebuilt from the base image or from `bun install` / dev runs — never persisted.
const EXCLUDES = ['node_modules', '.git', 'dist', '.wrangler', '.persist'];
const excludeArgs = EXCLUDES.map((e) => `--exclude=${e}`);

const run = async (cmd: string[], stdin?: Uint8Array): Promise<void> => {
  const proc = Bun.spawn(cmd, { stdin: stdin ? 'pipe' : 'ignore', stderr: 'pipe' });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${await new Response(proc.stderr).text()}`);
};

/** Tar the package subtree at `dir` (excluding the rebuilt dirs) to bytes. */
export async function tarSubtree(dir: string): Promise<Uint8Array> {
  const proc = Bun.spawn(['tar', '-cf', '-', ...excludeArgs, '-C', dir, '.'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0)
    throw new Error(`tar create failed: ${await new Response(proc.stderr).text()}`);
  return bytes;
}

// The extract half went with the boot restore (#366): nothing reads a content archive, so
// nothing unpacks one. It was wipe-then-extract, which is why a restore that ran against a
// stale or empty archive could clear a tree the image had populated.

// ── Per-canvas component dirs (ADR-0014) ────────────────────────────────────
// Every canvas own dir is `src/canvas-<id>/components/`; the platform base
// `src/canvas-components/` is image-only and NEVER captured or wiped here.

const CANVAS_DIR = /^canvas-(?!components$).+/;

/** The canvas own dirs under `srcRoot` (their `src`-relative paths), platform base excluded. */
export async function listCanvasDirs(srcRoot: string): Promise<string[]> {
  const entries = await readdir(srcRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && CANVAS_DIR.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Tar every canvas own dir (src-relative paths, so one extract restores them all).
 * No canvas dirs yet → an empty tar (a valid snapshot: "none exist"). */
export async function tarCanvasDirs(srcRoot: string): Promise<Uint8Array> {
  const dirs = await listCanvasDirs(srcRoot);
  const proc = Bun.spawn(
    dirs.length
      ? ['tar', '-cf', '-', ...excludeArgs, '-C', srcRoot, ...dirs]
      : ['tar', '-cf', '-', '-T', '/dev/null'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0)
    throw new Error(`tar create failed: ${await new Response(proc.stderr).text()}`);
  return bytes;
}

/** Newest mtime (ms) across every canvas own dir (the flushIfDirty guard for the
 * canvas-dirs tar). No dirs → 0 (nothing to save). */
export async function maxMtimeCanvasDirs(srcRoot: string): Promise<number> {
  let max = 0;
  for (const dir of await listCanvasDirs(srcRoot)) {
    max = Math.max(max, await maxMtimeMs(join(srcRoot, dir)));
  }
  return max;
}

/** Newest mtime (ms) under `dir`, skipping the EXCLUDES dirs by name at any depth. The
 *  turn-completion save uses it to skip re-tarring an unchanged component/skill library
 *  after a draw-only turn. An absent dir → 0 (nothing to save). */
export async function maxMtimeMs(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return 0; // absent dir
  let max = 0;
  for (const e of entries) {
    if (EXCLUDES.includes(e.name)) continue;
    const full = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? await maxMtimeMs(full) : (await stat(full)).mtimeMs);
  }
  return max;
}
