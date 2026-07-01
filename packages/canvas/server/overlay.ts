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

/** Replace the subtree at `dir` with the tar snapshot. Wipes tracked entries
 * first (keeping image-resident node_modules/.git) so a committed file the agent
 * deleted stays deleted, then extracts the complete snapshot over the top. */
export async function extractOverlay(bytes: Uint8Array, dir: string): Promise<void> {
  await run([
    'find', dir, '-mindepth', '1', '-maxdepth', '1',
    '!', '-name', 'node_modules', '!', '-name', '.git',
    '-exec', 'rm', '-rf', '{}', '+',
  ]);
  await run(['tar', '-xf', '-', '-C', dir], bytes);
}

/** Newest mtime (ms) under `dir`, skipping the EXCLUDES dirs by name at any depth. The
 *  turn-completion save uses it to skip re-tarring an unchanged component/custom library
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
