import { mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';

// Read-only repo checkouts (ADR-0016): the bridge maintains a shallow copy of each of the
// workspace's Repos under `<root>/.repos/<owner__name>` so CHAT turns can read repo content
// as plain files — no repo credential ever enters a turn. The token is used transiently for
// clone/fetch and scrubbed from the on-disk origin URL after every operation; the checkout
// is a mirror (local drift is discarded on refresh), never a working tree for edits — the
// dev-agent's worktrees (repo-worktree.ts) remain the only write surface.

export const CHECKOUTS_DIRNAME = '.repos';

/** Filesystem-safe per-repo dir (matches the dev-agent hub convention in bridge.ts). */
export const checkoutDirName = (repo: string): string => repo.replace('/', '__');

/** The op URL (token embedded) and the at-rest URL (scrubbed back after every op). */
export function checkoutUrls(repo: string, token?: string): { authed: string; publicUrl: string } {
  const publicUrl = `https://github.com/${repo}.git`;
  return { authed: token ? `https://x-access-token:${token}@github.com/${repo}.git` : publicUrl, publicUrl };
}

export interface RepoCheckoutConfig {
  repo: string; // owner/name
  root: string; // the workspace tree (CANVAS_CWD)
  token?: string; // transient read credential; never persisted
  /** Test override: a local path (or any URL) standing in for the GitHub remote. */
  remoteUrl?: string;
}

/** Clone-or-update the repo's read-only checkout. Shallow; follows the branch the clone
 *  landed on (the remote's default); discards any local drift (the checkout is a cache). */
export async function refreshCheckout(
  config: RepoCheckoutConfig,
): Promise<{ path: string; branch: string; head: string }> {
  const { authed, publicUrl } = config.remoteUrl
    ? { authed: config.remoteUrl, publicUrl: config.remoteUrl }
    : checkoutUrls(config.repo, config.token);
  const dir = join(config.root, CHECKOUTS_DIRNAME, checkoutDirName(config.repo));

  if (!existsSync(join(dir, '.git'))) {
    await mkdir(join(config.root, CHECKOUTS_DIRNAME), { recursive: true });
    await git(config.root, ['clone', '--depth', '1', authed, dir]);
  }
  try {
    // Refresh path (also right after a clone — idempotent): re-point origin at THIS op's
    // credential, follow the current branch, and hard-mirror it.
    await git(dir, ['remote', 'set-url', 'origin', authed]);
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    await git(dir, ['fetch', '--depth', '1', 'origin', branch]);
    await git(dir, ['reset', '--hard', 'FETCH_HEAD']);
    await git(dir, ['clean', '-fd']);
    const head = await git(dir, ['rev-parse', 'HEAD']);
    return { path: dir, branch, head };
  } finally {
    // Scrub: the at-rest origin never carries a credential.
    await git(dir, ['remote', 'set-url', 'origin', publicUrl]).catch(() => {});
  }
}

/** Drop a repo's checkout (the Settings "Remove" reconcile). */
export async function removeCheckout(root: string, repo: string): Promise<void> {
  await rm(join(root, CHECKOUTS_DIRNAME, checkoutDirName(repo)), { recursive: true, force: true });
}

/** The checkouts actually present on disk (a dir is one only once its clone landed). */
export function listCheckouts(root: string): Array<{ repo: string; path: string }> {
  let entries: string[];
  try {
    entries = readdirSync(join(root, CHECKOUTS_DIRNAME));
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.includes('__') && existsSync(join(root, CHECKOUTS_DIRNAME, e, '.git')))
    .sort()
    .map((e) => ({ repo: e.replace('__', '/'), path: `${CHECKOUTS_DIRNAME}/${e}` }));
}

/** System-prompt line advertising the workspace's Repo checkouts to chat agents — without
 *  it, agents don't spontaneously discover `.repos/`. Empty when nothing is checked out. */
export function reposPromptAppend(root: string): string {
  const list = listCheckouts(root);
  if (list.length === 0) return '';
  const items = list.map((c) => `${c.repo} → ${c.path}/`).join(', ');
  return `\n\nREPOS: this workspace's GitHub repos are checked out READ-ONLY under ${CHECKOUTS_DIRNAME}/ — ${items}. Read/Grep/ls them like ordinary local files to answer questions about those repos. They mirror each repo's default branch (refreshed on a cadence); never edit inside them — changes there are discarded and go nowhere.`;
}
