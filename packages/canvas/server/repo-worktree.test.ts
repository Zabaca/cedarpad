import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  branchName,
  composePr,
  createRepoWorktreeManager,
  DEFAULT_REPO,
  GITHUB_TOKEN_ENV,
  sanitizeRefComponent,
  worktreeDirName,
} from './repo-worktree.ts';

// ── Pure: branch naming ──────────────────────────────────────────────────────────────

describe('branch naming — unique + valid git ref chars', () => {
  test('namespaced under dev-agent/ and composed from workflow + run', () => {
    expect(branchName('improve-arch', 'run42')).toBe('dev-agent/improve-arch-run42');
  });

  test('is unique per run — same workflow, different runs never collide', () => {
    expect(branchName('wf', 'a')).not.toBe(branchName('wf', 'b'));
  });

  test('sanitizes illegal git ref characters to a safe slug', () => {
    // spaces, `~^:?*`, `..`, uppercase, slashes → collapsed to single dashes, trimmed.
    const b = branchName('Feat: Improve Arch~2', 'run..*99');
    expect(b).toBe('dev-agent/feat-improve-arch-2-run-99');
    // no whitespace or the forbidden set survives.
    expect(b).not.toMatch(/[ ~^:?*[\\]/);
    expect(b).not.toContain('..');
  });

  test('empty / all-illegal ids fall back rather than producing an invalid ref', () => {
    expect(sanitizeRefComponent('***')).toBe('run');
    expect(sanitizeRefComponent('')).toBe('run');
  });

  test('worktree dir is derived from the branch leaf so parallel workflows differ', () => {
    expect(worktreeDirName(branchName('wf1', 'r'))).toBe('wf1-r');
    expect(worktreeDirName(branchName('wf1', 'r'))).not.toBe(
      worktreeDirName(branchName('wf2', 'r')),
    );
  });
});

// ── Pure: PR-body assembly ───────────────────────────────────────────────────────────

describe('PR assembly — title/body/base/head composed correctly', () => {
  test('base defaults to main; head is the branch', () => {
    const spec = composePr('dev-agent/wf-run', { title: 'T', body: 'B' });
    expect(spec).toEqual({ title: 'T', body: 'B', base: 'main', head: 'dev-agent/wf-run' });
  });

  test('explicit base is respected', () => {
    expect(composePr('br', { title: 'T', body: 'B', base: 'develop' }).base).toBe('develop');
  });

  test('default upstream repo is Zabaca/cedarpad', () => {
    expect(DEFAULT_REPO).toBe('Zabaca/cedarpad');
  });
});

// ── Integration: clone/commit against a LOCAL scratch repo (no network, no GitHub) ─────

const runGit = async (cwd: string, args: string[]) => {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`);
  return (await new Response(p.stdout).text()).trim();
};

describe('prepareWorktree/commit/cleanup against a local scratch remote', () => {
  test('clones, worktrees off origin/main, commits, and cleans up', async () => {
    const root = join(tmpdir(), `RepoWorktreeIT_${process.pid}_${Date.now()}`);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const workspace = join(root, 'ws');
    try {
      // Build a local "GitHub": a bare remote seeded with one commit on main.
      mkdirSync(root, { recursive: true });
      await runGit(root, ['init', '--bare', '-b', 'main', remote]);
      await runGit(root, ['clone', remote, seed]);
      await Bun.write(join(seed, 'README.md'), '# seed\n');
      await runGit(seed, ['add', '-A']);
      await runGit(seed, ['commit', '-m', 'seed']);
      await runGit(seed, ['push', 'origin', 'main']);

      const mgr = createRepoWorktreeManager({
        repo: 'Zabaca/cedarpad',
        workspaceRoot: workspace,
        remoteUrl: remote, // local path stands in for the GitHub URL
      });

      const branch = branchName('it-workflow', 'run1');
      const wt = await mgr.prepareWorktree(branch);
      expect(existsSync(wt.path)).toBe(true);
      expect(existsSync(join(wt.path, 'README.md'))).toBe(true); // off origin/main
      expect(await runGit(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);

      // A clean tree → nothing to commit.
      expect(await mgr.commit(wt, 'noop')).toBe(false);

      // Agent edits a file → commit succeeds.
      await Bun.write(join(wt.path, 'NEW.txt'), 'hello');
      expect(await mgr.commit(wt, 'feat: add NEW')).toBe(true);
      expect(await runGit(wt.path, ['log', '-1', '--pretty=%s'])).toBe('feat: add NEW');

      await mgr.cleanup(wt);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Guard: real push+PR requires the token; unit suite must never hit GitHub ───────────

describe('pushAndOpenPR is gated on the GitHub token', () => {
  test('throws without DEV_AGENT_GITHUB_TOKEN instead of silently no-opping', async () => {
    const prev = process.env[GITHUB_TOKEN_ENV];
    delete process.env[GITHUB_TOKEN_ENV];
    try {
      const mgr = createRepoWorktreeManager({ repo: 'Zabaca/cedarpad', workspaceRoot: '/tmp/none' });
      await expect(
        mgr.pushAndOpenPR({ path: '/tmp/none', branch: 'b', hub: '/tmp/none' }, { title: 't', body: 'b' }),
      ).rejects.toThrow(GITHUB_TOKEN_ENV);
    } finally {
      if (prev !== undefined) process.env[GITHUB_TOKEN_ENV] = prev;
    }
  });
});
