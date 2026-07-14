// Repo worktree manager (ADR-0007, PRD #51 slice #64) — the git machinery that runs
// INSIDE the dev-agent container (Bun). The dev-agent clones `Zabaca/cedarpad`, works in
// a per-workflow worktree, then pushes a branch → PR. The PR is the DURABLE artifact: a
// non-git edit to the baked `/app` would evaporate on the next image roll, so every run's
// output must leave as a branch on the remote (ADR-0007). One worktree per concurrent
// workflow so parallel workflows never collide (ADR-0003 / worktree-safe).
//
// Split: the naming + PR-body assembly are PURE (unit-tested with no git). The
// clone/commit/push/PR are IO — integration-tested against a local scratch repo, and the
// real-GitHub push+PR is guarded behind the token being present so CI stays green with no
// secrets. See repo-worktree.test.ts.

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// ── Config / secret ────────────────────────────────────────────────────────────────────
//
// The push+PR path needs a GitHub token. It's a NEW edge secret, `DEV_AGENT_GITHUB_TOKEN`,
// read from the environment (never hardcoded). It must be provisioned:
//   - add to `packages/infra/environments/{production,preview}/secrets.yaml` (sops), and
//   - list it in `workerSecrets` in `packages/infra/environments/*/canvas.ts` so it rides
//     the container env like CLAUDE_CODE_OAUTH_TOKEN.
// Build/test do NOT require the real value: unit tests never touch it and the integration
// test runs fully offline against a local scratch remote.
export const GITHUB_TOKEN_ENV = 'DEV_AGENT_GITHUB_TOKEN';

export interface RepoWorktreeConfig {
  /** GitHub `owner/name` slug (or, in tests, an absolute path to a local scratch repo). */
  repo: string;
  /** Root dir under which the hub clone + per-workflow worktrees live. Worktree-safe: the
   *  caller derives this from the container's workspace, not a fixed shared path. */
  workspaceRoot: string;
  /** Explicit clone/remote URL. Tests pass a local repo path; in production it's derived
   *  from `repo` + token (`https://x-access-token:<tok>@github.com/<repo>.git`). */
  remoteUrl?: string;
  /** GitHub token (defaults to `process.env[GITHUB_TOKEN_ENV]`). */
  token?: string;
}

// ── Pure: naming ─────────────────────────────────────────────────────────────────────

// git ref components: no spaces, `~^:?*[\`, no `..`, no leading/trailing/`.lock`, etc.
// We normalize aggressively to a safe `[a-z0-9-]` slug so any workflow/run id is legal.
export function sanitizeRefComponent(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse every illegal run to a single dash
    .replace(/^-+|-+$/g, ''); // no leading/trailing dash
  return slug || 'run';
}

// Branch name: unique per workflow AND per run so a re-run (or a parallel workflow) never
// reuses a branch. Shape: `dev-agent/<workflow>-<run>`. Namespaced under `dev-agent/` so
// these branches are obviously machine-authored and easy to prune.
export function branchName(workflowId: string, runId: string): string {
  return `dev-agent/${sanitizeRefComponent(workflowId)}-${sanitizeRefComponent(runId)}`;
}

// The per-workflow worktree directory name (under workspaceRoot). Derived from the branch's
// leaf so two concurrent workflows land in distinct dirs (ADR-0003) — never a shared path.
export function worktreeDirName(branch: string): string {
  return sanitizeRefComponent(branch.replace(/^dev-agent\//, ''));
}

// ── Pure: PR-body assembly ───────────────────────────────────────────────────────────

export interface PrRequest {
  title: string;
  body: string;
  base?: string;
}

export interface PrSpec {
  title: string;
  body: string;
  base: string;
  head: string;
}

// Compose the PR fields from a run's title/body + the branch it's on. `base` defaults to
// `main`. Kept pure so the exact command/API payload is unit-testable without a network.
export function composePr(branch: string, req: PrRequest): PrSpec {
  return {
    title: req.title,
    body: req.body,
    base: req.base ?? 'main',
    head: branch,
  };
}

// ── IO: the git machinery ────────────────────────────────────────────────────────────

/** A prepared worktree handle threaded through commit/push/cleanup. */
export interface Worktree {
  /** Absolute path to the worktree working dir (where the agent edits + commits). */
  path: string;
  /** The branch checked out in this worktree. */
  branch: string;
  /** The hub clone this worktree was added to (for `worktree remove` / `branch -D`). */
  hub: string;
}

const git = async (cwd: string, args: string[], env?: Record<string, string>): Promise<string> => {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err.trim()}`);
  return out.trim();
};

const cfg = (c: RepoWorktreeConfig) => ({
  token: c.token ?? process.env[GITHUB_TOKEN_ENV],
  remoteUrl:
    c.remoteUrl ??
    (c.token ?? process.env[GITHUB_TOKEN_ENV]
      ? `https://x-access-token:${c.token ?? process.env[GITHUB_TOKEN_ENV]}@github.com/${c.repo}.git`
      : `https://github.com/${c.repo}.git`),
  hub: join(c.workspaceRoot, 'hub'),
});

export function createRepoWorktreeManager(config: RepoWorktreeConfig) {
  const { token, remoteUrl, hub } = cfg(config);

  // Clone-or-fetch the hub, then add a fresh worktree on a new branch off origin/main.
  async function prepareWorktree(branch: string): Promise<Worktree> {
    await mkdir(config.workspaceRoot, { recursive: true });

    if (existsSync(join(hub, '.git')) || existsSync(join(hub, 'HEAD'))) {
      // Re-point origin at THIS manager's URL first: the URL embeds the turn's short-lived
      // token, and a hub cloned by an earlier turn still carries that turn's (expired) one.
      await git(hub, ['remote', 'set-url', 'origin', remoteUrl]);
      await git(hub, ['fetch', 'origin', '--prune']);
    } else {
      await git(config.workspaceRoot, ['clone', remoteUrl, hub]);
    }

    const path = join(config.workspaceRoot, 'worktrees', worktreeDirName(branch));
    // `-B` so a stale branch from a crashed prior run is reset rather than erroring.
    await git(hub, ['worktree', 'add', '-B', branch, path, 'origin/main']);
    return { path, branch, hub };
  }

  // Reuse-or-create (ADR-0010 slice 6): a dev-agent grill flow spans turns — a later turn
  // must see an earlier turn's (possibly uncommitted) edits — so an existing worktree for
  // the branch is returned AS-IS, never reset. Only a missing one is freshly prepared off
  // origin/main. (A worktree's `.git` is a FILE pointing at the hub, so existsSync covers it.)
  async function ensureWorktree(branch: string): Promise<Worktree> {
    const path = join(config.workspaceRoot, 'worktrees', worktreeDirName(branch));
    if (existsSync(join(path, '.git'))) {
      // Reuse — but refresh origin's URL: it embeds the token of the turn that CLONED the
      // hub, which a multi-turn thread outlives (~1h). Every git auth (fetch/push/ls-remote)
      // reads this URL, so a stale one 401s the whole turn's GitHub access.
      await git(hub, ['remote', 'set-url', 'origin', remoteUrl]);
      return { path, branch, hub };
    }
    return prepareWorktree(branch);
  }

  // Stage everything the agent touched + commit. Returns false if the tree was clean
  // (nothing to commit) so callers can skip an empty push/PR.
  async function commit(wt: Worktree, message: string): Promise<boolean> {
    await git(wt.path, ['add', '-A']);
    const status = await git(wt.path, ['status', '--porcelain']);
    if (!status) return false;
    await git(wt.path, ['commit', '-m', message]);
    return true;
  }

  // Push the branch and open a PR. Requires the token (real GitHub) — throws without it so
  // it can never silently no-op. Uses `gh` (present in the product image) with the token in
  // the env; the pure `composePr` builds the exact fields.
  async function pushAndOpenPR(wt: Worktree, req: PrRequest): Promise<string> {
    if (!token)
      throw new Error(
        `${GITHUB_TOKEN_ENV} is not set — cannot push/open PR (provision it in secrets.yaml + canvas.ts workerSecrets)`,
      );
    const spec = composePr(wt.branch, req);
    await git(wt.path, ['push', '--force-with-lease', '-u', 'origin', wt.branch], {
      [GITHUB_TOKEN_ENV]: token,
    });
    const proc = Bun.spawn(
      [
        'gh',
        'pr',
        'create',
        '--repo',
        config.repo,
        '--head',
        spec.head,
        '--base',
        spec.base,
        '--title',
        spec.title,
        '--body',
        spec.body,
      ],
      { cwd: wt.path, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GH_TOKEN: token } },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`gh pr create failed (${code}): ${err.trim()}`);
    return out.trim(); // the PR URL
  }

  // Remove the worktree + delete its branch so the hub doesn't accumulate stale trees
  // across runs. Best-effort branch delete (the worktree removal is what frees the path).
  async function cleanup(wt: Worktree): Promise<void> {
    await git(wt.hub, ['worktree', 'remove', '--force', wt.path]);
    await rm(wt.path, { recursive: true, force: true });
    try {
      await git(wt.hub, ['branch', '-D', wt.branch]);
    } catch {
      // branch may not exist locally (e.g. never committed) — ignore.
    }
  }

  return { prepareWorktree, ensureWorktree, commit, pushAndOpenPR, cleanup };
}
